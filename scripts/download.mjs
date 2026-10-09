import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';

const execute = promisify(execFile);
function networkError(error) {
  return error?.name === 'TimeoutError' || error?.name === 'AbortError'
    || (error?.name === 'TypeError' && /fetch failed|terminated/i.test(error.message))
    || /^(?:E(?:CONNRESET|CONNREFUSED|TIMEDOUT|AI_AGAIN|NOTFOUND|HOSTUNREACH|NETUNREACH)|UND_ERR_(?:CONNECT_TIMEOUT|HEADERS_TIMEOUT|BODY_TIMEOUT|SOCKET))$/.test(error?.code ?? '')
    || (error?.cause && networkError(error.cause)) || error?.errors?.some(networkError);
}
async function downloadWithWindows(url, destination, env) {
  await execute('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    "$ErrorActionPreference = 'Stop'; [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -UseBasicParsing -Uri $env:AGENT_MOTION_DOWNLOAD_URL -OutFile $env:AGENT_MOTION_DOWNLOAD_FILE -TimeoutSec 180"], {
    windowsHide: true, timeout: 190000,
    env: { ...env, AGENT_MOTION_DOWNLOAD_URL: url, AGENT_MOTION_DOWNLOAD_FILE: destination },
  });
}

export async function fileHash(filename) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}
export async function downloadVerified(asset, destination, { platform = process.platform, windowsDownload = downloadWithWindows, env = process.env } = {}) {
  if (!/^https:\/\//.test(asset.url) || !/^[a-f0-9]{64}$/.test(asset.sha256)) throw new Error('Download requires HTTPS and a pinned SHA-256.');
  try {
    if ((await stat(destination)).isFile() && await fileHash(destination) === asset.sha256) return destination;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await mkdir(dirname(destination), { recursive: true });
  const temporary = destination + '.' + randomUUID() + '.part';
  console.log(`Downloading ${asset.url.split('/').at(-1)} …`);
  try {
    let bytes = 0;
    try {
      const response = await fetch(asset.url, { signal: AbortSignal.timeout(platform === 'win32' ? 60000 : 600000) });
      if (!response.ok || !response.body) throw new Error(`Download returned HTTP ${response.status}`);
      const counter = new Transform({ transform(chunk, encoding, callback) {
        bytes += chunk.length;
        callback(asset.bytes && bytes > asset.bytes ? new Error('Download exceeds pinned size') : null, chunk);
      } });
      await pipeline(Readable.fromWeb(response.body), counter, createWriteStream(temporary, { flags: 'wx' }));
    } catch (error) {
      if (platform !== 'win32' || !networkError(error)) throw error;
      await rm(temporary, { force: true });
      console.log('Node network transfer failed; trying the Windows system downloader …');
      await windowsDownload(asset.url, temporary, env);
      bytes = (await stat(temporary)).size;
    }
    if (asset.bytes && bytes !== asset.bytes) throw new Error('Downloaded size does not match');
    if (await fileHash(temporary) !== asset.sha256) throw new Error('Downloaded checksum does not match; file was not installed');
    await rename(temporary, destination);
    return destination;
  } catch (error) {
    await rm(temporary, { force: true });
    throw new Error(`${error.message}. Check network access to ${new URL(asset.url).hostname} and rerun the same setup command.`);
  }
}
