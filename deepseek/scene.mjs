import * as THREE from 'three';

/** Editable, absolute-time talking-head composition shared by the three styles. */
export async function mount() {
  const film = await fetch('./film.json').then(response => response.json());
  const { width: W, height: H, style: s } = film;
  await document.fonts.load(`48px "${s.typography.titleFont}"`);
  await document.fonts.load(`48px "${s.typography.bodyFont}"`);
  await document.fonts.ready;
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setSize(W, H);
  renderer.setPixelRatio(1);
  renderer.setClearColor(s.palette.background);
  document.body.append(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(35, W / H, 1, 3000);
  camera.position.z = 1000;
  const worldHeight = 2 * 1000 * Math.tan(THREE.MathUtils.degToRad(35 / 2));
  const worldWidth = worldHeight * W / H;
  const unit = H / 1080;
  function rectangle(x, y, width, height, color, z = 0, opacity = 1) {
    const material = new THREE.MeshBasicMaterial({ color, transparent: opacity < 1, opacity, depthWrite: opacity === 1 });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(worldWidth * width, worldHeight * height), material);
    const scale = (1000 - z) / 1000;
    mesh.scale.setScalar(scale);
    mesh.position.set((x + width / 2 - .5) * worldWidth * scale, (.5 - y - height / 2) * worldHeight * scale, z);
    scene.add(mesh);
    return mesh;
  }
  function text(x, y, width, height, value, size, color, font, options = {}) {
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(width * W);
    canvas.height = Math.ceil(height * H);
    const context = canvas.getContext('2d');
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const plane = rectangle(x, y, width, height, 0xffffff, 25);
    plane.material = new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false });
    function update(content) {
      context.clearRect(0, 0, canvas.width, canvas.height);
      let fontSize = size * unit;
      let lines;
      function wrap() {
        context.font = `${options.weight ?? 500} ${fontSize}px "${font}","${s.typography.bodyFont}"`;
        const result = [];
        for (const paragraph of content.split('\n')) {
          let line = '';
          for (const character of paragraph) {
            if (line && context.measureText(line + character).width > canvas.width - 4 * unit) { result.push(line); line = ''; }
            line += character;
          }
          result.push(line);
        }
        return result;
      }
      lines = wrap();
      while (lines.length * fontSize * 1.26 > canvas.height && fontSize > 18 * unit) { fontSize -= 2 * unit; lines = wrap(); }
      if (lines.length * fontSize * 1.26 > canvas.height) throw new Error('文字无法完整放入安全区，请拆分字幕或调整排版。');
      context.fillStyle = color;
      context.textBaseline = 'top';
      lines.forEach((line, index) => context.fillText(line, 0, index * fontSize * 1.26));
      texture.needsUpdate = true;
    }
    update(value);
    return { plane, update };
  }
  // Real depth separates background, suspended person, title and subtitles.
  if (s.id === 'technology') {
    for (let i = 0; i < 12; i++) rectangle(i / 12, 0, .0007, 1, s.palette.accent, -20, .1);
    for (let i = 0; i < 8; i++) rectangle(0, i / 8, 1, .0007, s.palette.accentSecondary, -22, .12);
  } else if (s.id === 'education') {
    for (let i = 0; i < 15; i++) rectangle(0, i / 15, 1, .0008, s.palette.accent, -20, .08);
    rectangle(.335, .16, .0013, .68, s.palette.accentSecondary, -2);
  } else {
    const disk = new THREE.Mesh(new THREE.CircleGeometry(worldHeight * .49, 80), new THREE.MeshBasicMaterial({ color: s.palette.accentSecondary }));
    disk.position.set(worldWidth * .265, 0, -40);
    scene.add(disk);
    rectangle(.055, .66, .52, .105, s.palette.accent, 5);
  }
  if (film.backgroundImage) {
    if (!/^background\.(?:png|jpg|webp)$/.test(film.backgroundImage)) throw new Error('背景图必须是本工程中的本地图片。');
    const texture = await new THREE.TextureLoader().loadAsync(`./${film.backgroundImage}`);
    texture.colorSpace = THREE.SRGBColorSpace;
    const imageAspect = texture.image.width / texture.image.height, filmAspect = W / H;
    if (imageAspect > filmAspect) { texture.repeat.x = filmAspect / imageAspect; texture.offset.x = (1 - texture.repeat.x) / 2; }
    else { texture.repeat.y = imageAspect / filmAspect; texture.offset.y = (1 - texture.repeat.y) / 2; }
    const background = rectangle(0, 0, 1, 1, '#ffffff', -10);
    background.material = new THREE.MeshBasicMaterial({ map: texture });
    // A template-colored veil keeps real Chinese typography readable over generated imagery.
    rectangle(0, 0, 1, 1, s.palette.background, -9, .7);
  }
  const p = s.layout.person;
  rectangle(p.x + .012, p.y + .018, p.width, p.height, '#000000', -4, s.id === 'education' ? .13 : .28);
  if (s.id !== 'marketing') rectangle(p.x - .006, p.y - .008, p.width + .012, p.height + .016, s.palette.surface, 5);
  async function video(url) {
    const element = document.createElement('video');
    element.src = url;
    element.muted = true;
    element.playsInline = true;
    element.preload = 'auto';
    await new Promise((resolve, reject) => { element.addEventListener('loadeddata', resolve, { once: true }); element.addEventListener('error', () => reject(new Error(`无法解码视频：${url}`)), { once: true }); element.load(); });
    return element;
  }
  const foreground = await video(film.keepBackground ? './source.mp4' : './person/foreground.mp4');
  const alpha = film.keepBackground ? undefined : await video('./person/alpha.mp4');
  const colorTexture = new THREE.VideoTexture(foreground);
  colorTexture.colorSpace = THREE.SRGBColorSpace;
  const alphaTexture = alpha ? new THREE.VideoTexture(alpha) : undefined;
  // ponytail: upper-body alpha centroid; explicit anchors correct multi-person or off-center shots.
  let anchorX = .5;
  if (alpha && film.framing?.anchorX === undefined) {
    const sample = document.createElement('canvas'); sample.width = 128; sample.height = 128;
    const context = sample.getContext('2d'); context.drawImage(alpha, 0, 0, 128, 128);
    const pixels = context.getImageData(0, 0, 128, 64).data;
    let sum = 0, weight = 0;
    for (let y = 0; y < 64; y++) for (let x = 0; x < 128; x++) { const opacity = pixels[(y * 128 + x) * 4 + 1]; if (opacity > 96) { sum += x * opacity; weight += opacity; } }
    if (weight) anchorX = sum / weight / 128;
  }
  const ratio = (p.width * W / (p.height * H)) / (foreground.videoWidth / foreground.videoHeight);
  const uvScale = ratio > 1 ? new THREE.Vector2(1, 1 / ratio) : new THREE.Vector2(ratio, 1);
  uvScale.divideScalar(film.framing?.scale ?? 1);
  const uvOffset = new THREE.Vector2(THREE.MathUtils.clamp((film.framing?.anchorX ?? anchorX) - uvScale.x / 2, 0, 1 - uvScale.x), THREE.MathUtils.clamp(film.framing?.anchorY === undefined ? 1 - uvScale.y : 1 - film.framing.anchorY - uvScale.y / 2, 0, 1 - uvScale.y));
  const person = rectangle(p.x, p.y, p.width, p.height, '#ffffff', 12);
  if (alphaTexture) {
    person.material = new THREE.ShaderMaterial({
      uniforms: { colorVideo: { value: colorTexture }, alphaVideo: { value: alphaTexture }, uvScale: { value: uvScale }, uvOffset: { value: uvOffset }, edgeStep: { value: new THREE.Vector2(.012 * uvScale.x, .012 * uvScale.y) }, outline: { value: new THREE.Color(s.palette.accent) } },
      vertexShader: 'varying vec2 videoUv;uniform vec2 uvScale;uniform vec2 uvOffset;void main(){videoUv=uv*uvScale+uvOffset;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',
      fragmentShader: 'varying vec2 videoUv;uniform sampler2D colorVideo;uniform sampler2D alphaVideo;uniform vec2 edgeStep;uniform vec3 outline;void main(){float a=texture2D(alphaVideo,videoUv).g;float outer=a;for(int x=-1;x<=1;x++){for(int y=-1;y<=1;y++){outer=max(outer,texture2D(alphaVideo,videoUv+vec2(float(x),float(y))*edgeStep).g);}}vec3 c=texture2D(colorVideo,videoUv).rgb;gl_FragColor=vec4(mix(outline,c,smoothstep(0.03,0.2,a)),outer);}',
      transparent: true, depthWrite: false,
    });
  } else {
    colorTexture.repeat.copy(uvScale);
    colorTexture.offset.copy(uvOffset);
    person.material = new THREE.MeshBasicMaterial({ map: colorTexture });
  }
  const t = s.layout.title;
  const headline = text(t.x, t.y, t.width, .36, film.title, s.id === 'marketing' ? 104 : 88, s.palette.text, s.typography.titleFont, { weight: 700 });
  text(t.x, .095, t.width, .06, s.content.eyebrow, 29, s.palette.accent, s.typography.bodyFont);
  const keyPoints = film.keyPoints ?? s.content.steps;
  const stepCards = [];
  if (s.id === 'technology') {
    for (let i = 0; i < 3; i++) {
      const x = t.x + i * t.width / 3;
      stepCards.push(rectangle(x, .61, t.width / 3 - .016, .15, s.palette.surface, 5));
      text(x + .009, .63, t.width / 3 - .035, .12, `${String(i + 1).padStart(2, '0')}\n${keyPoints[i]}`, 27, s.palette.text, s.typography.bodyFont);
      if (i < 2) rectangle(x + t.width / 3 - .016, .684, .016, .003, s.palette.accent, 6);
    }
  } else if (s.id === 'education') {
    rectangle(t.x - .015, .54, t.width + .02, .275, s.palette.surface, 5);
    for (let i = 0; i < 3; i++) {
      stepCards.push(rectangle(t.x, .557 + i * .08, .03, .003, s.palette.accentSecondary, 7));
      text(t.x + .04, .555 + i * .08, t.width - .05, .074, `${i + 1}  ${keyPoints[i]}`, 32, s.palette.text, s.typography.bodyFont);
    }
  } else {
    for (let i = 0; i < 3; i++) {
      stepCards.push(rectangle(t.x, .535 + i * .073, t.width - .025, .061, s.palette.surface, 6));
      text(t.x + .014, .544 + i * .073, t.width - .065, .048, keyPoints[i], 31, s.palette.accentSecondary, s.typography.bodyFont);
    }
  }
  const sub = s.layout.subtitle;
  rectangle(sub.x - .012, sub.y - .014, sub.width + .024, .108, '#000000', 24, .77);
  const subtitle = text(sub.x, sub.y, sub.width, .076, '', 43, '#ffffff', s.typography.bodyFont);
  const progress = rectangle(.04, .98, .92, .004, s.palette.accent, 30);
  const basePosition = person.position.clone();
  const headlinePosition = headline.plane.position.clone();
  let currentCue = -2;
  function ease(value) {
    const x = Math.max(0, Math.min(1, value));
    return s.motion.easing === 'sine-in-out' ? -(Math.cos(Math.PI * x) - 1) / 2 : 1 - (1 - x) ** 3;
  }
  function draw(time) {
    const entrance = ease(time / s.motion.durationSeconds);
    person.position.copy(basePosition);
    if (s.id === 'education') person.position.x -= (1 - entrance) * worldWidth * .018;
    else person.position.z += (1 - entrance) * 28;
    headline.plane.position.copy(headlinePosition);
    headline.plane.position.y -= (1 - entrance) * worldHeight * (s.id === 'marketing' ? .055 : .015);
    const index = film.cues.findIndex(cue => time >= cue.start && time < cue.end);
    if (index !== currentCue) {
      currentCue = index;
      const cue = film.cues[index];
      subtitle.update(cue?.text ?? '');
      stepCards.forEach((card, step) => card.material.color.set(step === Math.min(2, Math.floor(Math.max(0, index) * 3 / film.cues.length)) ? (s.id === 'marketing' ? s.palette.accent : s.id === 'technology' ? '#173D4A' : s.palette.accentSecondary) : (s.id === 'education' ? s.palette.accentSecondary : s.palette.surface)));
    }
    progress.scale.x = Math.max(.001, Math.min(1, time / film.duration));
    renderer.render(scene, camera);
  }
  async function seek(element, time) {
    const target = Math.min(time, Math.max(0, element.duration - .001));
    if (Math.abs(element.currentTime - target) < .00001) return;
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('视频定位超时，检查时间轴与媒体。')), 15000);
      element.addEventListener('seeked', () => { clearTimeout(timeout); resolve(); }, { once: true });
      element.currentTime = target;
    });
  }
  window.film = { async renderAt(time) {
    await Promise.all([seek(foreground, time), ...(alpha ? [seek(alpha, time)] : [])]);
    colorTexture.needsUpdate = true;
    if (alphaTexture) alphaTexture.needsUpdate = true;
    draw(time);
  } };
  await window.film.renderAt(0);
  if (!new URLSearchParams(location.search).has('capture')) {
    const play = document.createElement('button');
    play.textContent = '播放预览';
    Object.assign(play.style, { position: 'fixed', top: '12px', right: '12px', border: 'none', borderRadius: '5px', padding: '10px 16px', fontFamily: s.typography.bodyFont, cursor: 'pointer' });
    document.body.append(play);
    const speech = document.createElement('audio');
    speech.src = './source.mp4';
    speech.preload = 'auto';
    const music = film.music ? document.createElement('audio') : undefined;
    if (music) { music.src = './music.audio'; music.volume = film.music.volume; music.loop = true; }
    let playing = false, started = 0;
    play.onclick = async () => {
      if (playing) { playing = false; foreground.pause(); alpha?.pause(); speech.pause(); music?.pause(); play.textContent = '播放预览'; return; }
      await window.film.renderAt(0);
      speech.currentTime = 0;
      if (music) music.currentTime = 0;
      await Promise.all([foreground.play(), ...(alpha ? [alpha.play()] : []), ...(film.hasAudio ? [speech.play()] : []), ...(music ? [music.play()] : [])]);
      started = performance.now(); playing = true; play.textContent = '暂停预览';
      function tick(now) {
        if (!playing) return;
        const time = film.hasAudio ? speech.currentTime : (now - started) / 1000;
        draw(Math.min(time, film.duration));
        if (time < film.duration && !foreground.ended) requestAnimationFrame(tick);
        else { playing = false; foreground.pause(); alpha?.pause(); speech.pause(); music?.pause(); play.textContent = '重新播放'; }
      }
      requestAnimationFrame(tick);
    };
  }
}
