import * as THREE from 'three';
import Stats from 'three/addons/libs/stats.module.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { Octree } from 'three/addons/math/Octree.js';
import { OctreeHelper } from 'three/addons/helpers/OctreeHelper.js';
import { Capsule } from 'three/addons/math/Capsule.js';
import { GUI } from 'three/addons/libs/lil-gui.module.min.js';

/* ===================== Config rápida de rendimiento ===================== */
const FAST_MODE = true;          // true = no crea PointLights/Sprites por pelota (gran boost)
const MAX_PIXEL_RATIO = 1.0;     // limita la resolución para evitar picos
const SHADOW_MAP_SIZE = 512;     // 512 es bastante más ligero que 1024

/* ===================== Scene, Camera, Renderer ===================== */
const clock = new THREE.Clock();
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x88ccee);
scene.fog = new THREE.Fog(0x88ccee, 0, 50);

const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 1000);
camera.rotation.order = 'YXZ';

/* ===== Audio (WAVs) ===== */
const listener = new THREE.AudioListener();
camera.add(listener);
const audioLoader = new THREE.AudioLoader();
const audioBuffers = new Map();

const AUDIO_EMOTES = ['emote1.wav','emote2.wav','emote3.wav'];
const AUDIO_WIN = 'win.wav';
const AUDIO_LOSE = 'lose.wav';

function preloadAudio(files){
  files.forEach(fn=>{
    audioLoader.load(`./audio/${fn}`, (buf)=> audioBuffers.set(fn, buf));
  });
}
preloadAudio([...AUDIO_EMOTES, AUDIO_WIN, AUDIO_LOSE]);

function playSfx(name, volume=0.85){
  const buf = audioBuffers.get(name);
  if (!buf) return;
  const a = new THREE.Audio(listener);
  a.setBuffer(buf);
  a.setVolume(volume);
  a.play();
}

/* ===== Luces ===== */
const hemi = new THREE.HemisphereLight(0x8dc1de, 0x00668d, 1.25);
hemi.position.set(2, 1, 1);
scene.add(hemi);

const sun = new THREE.DirectionalLight(0xffffff, 2.0);
sun.position.set(-5, 25, -1);
sun.castShadow = true;
Object.assign(sun.shadow.camera, { near: 0.01, far: 500, right: 30, left: -30, top: 30, bottom: -30 });
sun.shadow.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);
sun.shadow.radius = 2;
sun.shadow.bias = -0.0002;
scene.add(sun);

/* ===== Renderer / Stats ===== */
const container = document.getElementById('container');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(MAX_PIXEL_RATIO, window.devicePixelRatio));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setAnimationLoop(animate);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
container.appendChild(renderer.domElement);

const stats = new Stats();
stats.dom.style.position = 'absolute';
stats.dom.style.top = '0px';
container.appendChild(stats.dom);

/* ===================== Physics & Player ===================== */
const GRAVITY = 30;
const NUM_SPHERES = 30;
const SPHERE_RADIUS = 0.2;
const STEPS_PER_FRAME = 2;

const worldOctree = new Octree();
const playerCollider = new Capsule(
  new THREE.Vector3(0, 0.35, 0),
  new THREE.Vector3(0, 1.00, 0),
  0.35
);

const playerVelocity = new THREE.Vector3();
const playerDirection = new THREE.Vector3();
let playerOnFloor = false;

let mouseTime = 0;
const keyStates = {};
let gameOver = false;
let youWon = false;

const v1 = new THREE.Vector3();
const v2 = new THREE.Vector3();
const v3 = new THREE.Vector3();

/* ---------- FIRE helpers ---------- */
function makeFireTexture() {
  const size = 128;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(size*0.5,size*0.6,8, size*0.5,size*0.6,size*0.5);
  grd.addColorStop(0.00, 'rgba(255,255,255,1)');
  grd.addColorStop(0.18, 'rgba(255,240,180,0.95)');
  grd.addColorStop(0.45, 'rgba(255,150,50,0.75)');
  grd.addColorStop(0.75, 'rgba(255,80,0,0.45)');
  grd.addColorStop(1.00, 'rgba(0,0,0,0)');
  g.fillStyle = grd;
  g.fillRect(0,0,size,size);
  return new THREE.CanvasTexture(c);
}
const FIRE_TEX = makeFireTexture();

/* ---------- Spheres ---------- */
const sphereGeo = new THREE.IcosahedronGeometry(SPHERE_RADIUS, 4);
const sphereMat = new THREE.MeshStandardMaterial({
  color: 0xff6a00,
  emissive: 0x7a1200,
  emissiveIntensity: 1.0,
  roughness: 0.35,
  metalness: 0.1
});
const spheres = [];
let sphereIdx = 0;

function makeBallLight(){
  const l = new THREE.PointLight(0xff5a00, 1.0, 3.2, 2.0);
  l.visible = false;
  scene.add(l);
  return l;
}
function makeFlameSprite(){
  const sm = new THREE.SpriteMaterial({
    map: FIRE_TEX,
    depthWrite: false,
    transparent: true,
    blending: THREE.AdditiveBlending
  });
  const s = new THREE.Sprite(sm);
  s.visible = false;
  scene.add(s);
  return s;
}

for (let i = 0; i < NUM_SPHERES; i++) {
  const mesh = new THREE.Mesh(sphereGeo, sphereMat.clone());
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  scene.add(mesh);
  const light = FAST_MODE ? null : makeBallLight();
  const flame = FAST_MODE ? null : makeFlameSprite();
  spheres.push({
    mesh,
    collider: new THREE.Sphere(new THREE.Vector3(0, -100, 0), SPHERE_RADIUS),
    velocity: new THREE.Vector3(),
    active: false,
    hitCooldown: 0,
    light,
    flame,
    flickerT: Math.random()*100
  });
}

/* ===================== World GLTF ===================== */
let worldScene = null;
let worldBounds = null; // para spawns globales
const gltfLoader = new GLTFLoader().setPath('./models/gltf/');
gltfLoader.load('squid_game_hide_and_seek.glb', (gltf) => {
  scene.add(gltf.scene);
  worldScene = gltf.scene;
  worldOctree.fromGraphNode(gltf.scene);

  gltf.scene.traverse((c) => {
    if (c.isMesh) {
      c.castShadow = true;
      c.receiveShadow = true;
      if (c.material?.map) c.material.map.anisotropy = 2;
    }
  });

  // bounds globales del escenario
  worldBounds = new THREE.Box3().setFromObject(gltf.scene);

  const helper = new OctreeHelper(worldOctree);
  helper.visible = false;
  scene.add(helper);

  new GUI({ width:200 }).add({ debug:false }, 'debug').onChange(v => helper.visible = v);
});

/* ===================== Input ===================== */
document.addEventListener('keydown', (e) => {
  keyStates[e.code] = true;
  if (e.code === 'KeyR') requestRestart();
});
document.addEventListener('keyup',   (e) => (keyStates[e.code] = false));

container.addEventListener('mousedown', () => {
  document.body.requestPointerLock();
  mouseTime = performance.now();
});
document.addEventListener('mouseup', () => {
  if (document.pointerLockElement !== null) throwBall();
});
document.body.addEventListener('mousemove', (e) => {
  if (document.pointerLockElement === document.body) {
    camera.rotation.y -= e.movementX / 520;
    camera.rotation.x -= e.movementY / 520;
  }
});
window.addEventListener('resize', onWindowResize);
function onWindowResize(){
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(MAX_PIXEL_RATIO, window.devicePixelRatio));
}

/* ===================== HUD de controles ===================== */
const controlsHint = document.createElement('div');
controlsHint.style.cssText = `
  position:fixed; left:12px; bottom:12px; z-index:15; color:#fff;
  font-family:system-ui; font-weight:600; text-shadow:0 2px 6px rgba(0,0,0,.8);
  background:rgba(0,0,0,.35); padding:8px 10px; border-radius:8px; font-size:14px;
`;
controlsHint.textContent = 'WASD: mover | MOUSE: mirar/lanza | SPACE: saltar | R: reiniciar';
document.body.appendChild(controlsHint);

/* ===================== NPCs (caminar + emotes) ===================== */
const NPC_IDLE = 'Walking'; // <-- ahora Walking.fbx
const EMOTE_LIST = [
  'Reaction','Sitting Clap','Hip Hop Dancing','Jumping Down','Praying','Rumba Dancing','Dying'
];
const NPC_TARGET_HEIGHT = 1.25;

/* —— Densidad global y anti-cluster —— */
const NPC_MAX = 8;
const NPC_MIN_DIST_BETWEEN = 2.25;
const CELL_SIZE = 6;              // tamaño de celda ~6m
const CELL_MAX = 2;               // máximo 2 NPC por celda
const cellCounts = new Map();     // "ix,iz" -> count

function cellKey(pos){
  const ix = Math.floor(pos.x / CELL_SIZE);
  const iz = Math.floor(pos.z / CELL_SIZE);
  return `${ix},${iz}`;
}
function cellCanAdd(pos){
  const k = cellKey(pos);
  return (cellCounts.get(k) || 0) < CELL_MAX;
}
function cellAdd(pos){
  const k = cellKey(pos);
  cellCounts.set(k, (cellCounts.get(k) || 0) + 1);
}
function cellRemove(pos){
  const k = cellKey(pos);
  const v = (cellCounts.get(k) || 0) - 1;
  if (v <= 0) cellCounts.delete(k); else cellCounts.set(k, v);
}

const NPC_LOCAL_CLUSTER_RADIUS = 4.0;
const NPC_LOCAL_MAX = 3;
const NPC_SPAWN_DISTANCE = { min: 4, max: 10 };

// --- Persecución y derrota
const NPC_BASE_SPEED = 0.9;           // velocidad base de caminata
const NPC_CHASE_BOOST = 0.6;          // cuanto más rápido cuando te ven
const NPC_LOSE_DISTANCE = 0.9;        // distancia para perder

const NPCS = [];
const fbxLoader = new FBXLoader();
const npcClips = new Map();

function loadFBX(path){
  return new Promise((res, rej) => fbxLoader.load(path, res, undefined, rej));
}
(async ()=>{
  for (const name of EMOTE_LIST) {
    try {
      const fbx = await loadFBX(`./models/fbx/${name}.fbx`);
      if (fbx.animations?.length) {
        const clip = fbx.animations[0]; clip.optimize();
        npcClips.set(name, clip);
      }
    } catch(e){}
  }
})();

function fitToHeight(obj, targetH){
  const box = new THREE.Box3().setFromObject(obj);
  const size = new THREE.Vector3(); box.getSize(size);
  const h = size.y || 1; const s = targetH / h;
  obj.scale.multiplyScalar(s);
  const box2 = new THREE.Box3().setFromObject(obj);
  const minY = box2.min.y;
  obj.position.y += -minY;
}

/* ===================== Raycasts helpers ===================== */
const raycaster = new THREE.Raycaster();
function floorAtXZ(x, z) {
  if (!worldScene) return null;
  const from = new THREE.Vector3(x, -1000, z);
  raycaster.set(from, new THREE.Vector3(0, 1, 0));
  raycaster.far = 5000;
  const hits = raycaster.intersectObject(worldScene, true);
  return hits.length ? hits[0].point.clone() : null;
}
function castHorizontalDistance(origin, dir, maxDist = 5) {
  if (!worldScene) return maxDist;
  const from = origin.clone().add(new THREE.Vector3(0, 0.6, 0));
  const rayDir = dir.clone().setY(0).normalize();
  raycaster.set(from, rayDir);
  raycaster.far = maxDist;
  const hit = raycaster.intersectObject(worldScene, true)[0];
  return hit ? hit.distance : maxDist;
}
function ceilingClearanceAt(point) {
  if (!worldScene) return Infinity;
  const from = point.clone().add(new THREE.Vector3(0, 0.02, 0));
  raycaster.set(from, new THREE.Vector3(0, 1, 0));
  raycaster.far = 100;
  const hit = raycaster.intersectObject(worldScene, true)[0];
  return hit ? (hit.point.y - point.y) : Infinity;
}

/* ======= Helpers de colisión/unstuck para NPC ======= */
function npcCollisionSphere(npc){
  // esfera a la altura del torso/piernas
  const center = npc.group.position.clone().add(new THREE.Vector3(0, 0.6, 0));
  const r = Math.max(0.28, Math.min(0.45, npc.radius * 0.35));
  return new THREE.Sphere(center, r);
}
function resolveNPCCollision(npc){
  const sph = npcCollisionSphere(npc);
  const hit = worldOctree.sphereIntersect(sph);
  if (hit){
    // saca al NPC de la pared con un pequeño margen
    npc.group.position.add(hit.normal.multiplyScalar(hit.depth + 0.02));
    return true;
  }
  return false;
}
function recentreInCorridor(npc, dirHint){
  const dir = dirHint ? dirHint.clone() : new THREE.Vector3(0,0,1);
  const sideR = new THREE.Vector3(dir.z, 0, -dir.x);
  const dR = castHorizontalDistance(npc.group.position, sideR, 2.0);
  const dL = castHorizontalDistance(npc.group.position, sideR.clone().multiplyScalar(-1), 2.0);
  const offset = THREE.MathUtils.clamp((dR - dL) * 0.35, -0.6, 0.6);
  npc.group.position.add(sideR.multiplyScalar(offset * 0.25)); // ajuste suave
}

/* === Anti-cluster local === */
function isTooCrowded(pos){
  let count = 0;
  for (const n of NPCS){
    if (n.group.position.distanceTo(pos) <= NPC_LOCAL_CLUSTER_RADIUS) count++;
    if (count >= NPC_LOCAL_MAX) return true;
  }
  return false;
}

/* === Spawn en una posición validada === */
function spawnAtPosition(basePos, forwardHint){
  if (!worldScene || gameOver || NPCS.length >= NPC_MAX) return false;

  // centra en pasillo
  const sideDir = getSideVector().clone();
  const MAX_CORRIDOR_HALF = 3.0;
  const minClearSide = 0.5;

  const dRight = castHorizontalDistance(basePos,  sideDir, MAX_CORRIDOR_HALF);
  const dLeft  = castHorizontalDistance(basePos,  sideDir.clone().multiplyScalar(-1), MAX_CORRIDOR_HALF);
  if (dRight < minClearSide || dLeft < minClearSide) return false;

  const lateralOffset = THREE.MathUtils.clamp((dRight - dLeft) * 0.5, -MAX_CORRIDOR_HALF, MAX_CORRIDOR_HALF);
  const centeredXZ = basePos.clone().add(sideDir.multiplyScalar(lateralOffset));
  const centeredFloor = floorAtXZ(centeredXZ.x, centeredXZ.z);
  if (!centeredFloor) return false;
  if (ceilingClearanceAt(centeredFloor) < 1.7) return false;

  for (const n of NPCS){
    if (n.group.position.distanceTo(centeredFloor) < NPC_MIN_DIST_BETWEEN) return false;
  }
  if (isTooCrowded(centeredFloor)) return false;

  // crea
  loadFBX(`./models/fbx/${NPC_IDLE}.fbx`).then((fbx)=>{
    const group = fbx;
    group.traverse((c)=>{ if (c.isMesh){ c.castShadow = true; c.receiveShadow = true; }});
    fitToHeight(group, NPC_TARGET_HEIGHT);
    group.position.copy(centeredFloor).add(new THREE.Vector3(0, 0.01, 0)); // toca suelo

    const dir = forwardHint ? forwardHint.clone().setY(0).normalize() : getForwardVector().clone();
    group.rotation.y = Math.atan2(dir.x, dir.z);
    scene.add(group);

    const mixer = new THREE.AnimationMixer(group);
    let idleAction = null;
    if (fbx.animations?.length){
      idleAction = mixer.clipAction(fbx.animations[0], group);
      // 🔁 camina SIN parar
      idleAction.setLoop(THREE.LoopRepeat, Infinity);
      idleAction.clampWhenFinished = false;
      idleAction.enabled = true;
      idleAction.play();
    }

    const box = new THREE.Box3().setFromObject(group);
    const rad = Math.max(0.5, box.getSize(new THREE.Vector3()).length() * 0.25);

    const npc = {
      group,
      mixer,
      idleAction,
      currentAction: idleAction,
      state: 'idle',
      radius: rad,
      ttl: 9999,
      dir,
      speed: NPC_BASE_SPEED + Math.random()*0.25,
      turnTimer: 0.7 + Math.random()*0.6,
      senseTimer: 0,
      _lateralOffset: 0,
      _flashLight: null,
      _stuckTime: 0,
      _lastPos: group.position.clone()
    };

    // Intento de "despegar" si por algún detalle de malla quedó tocando pared
    let safetyIters = 0;
    while (resolveNPCCollision(npc) && safetyIters++ < 4) {}
    // Si aún así chocó techo/pareces, recentrar un poco
    recentreInCorridor(npc, dir);

    // anti-cluster por celda (usa posición final)
    if (!cellCanAdd(npc.group.position)){
      scene.remove(group);
      return;
    }
    cellAdd(npc.group.position);
    NPCS.push(npc);
  }).catch(()=>{});
  return true;
}

/* === Spawns: adelante / anillo / GLOBAL === */
function spawnNPCAhead(){
  const forward = getForwardVector().clone();
  const dist = THREE.MathUtils.randFloat(NPC_SPAWN_DISTANCE.min, NPC_SPAWN_DISTANCE.max);
  const probeXZ = playerCollider.end.clone().addScaledVector(forward, dist);
  const floorPoint = floorAtXZ(probeXZ.x, probeXZ.z);
  if (!floorPoint) return false;
  return spawnAtPosition(floorPoint, forward);
}
function spawnNPCInRing(){
  const tries = 3;
  for (let i=0;i<tries;i++){
    const ang = Math.random()*Math.PI*2;
    const dist = THREE.MathUtils.randFloat(NPC_SPAWN_DISTANCE.min, NPC_SPAWN_DISTANCE.max);
    const px = playerCollider.end.x + Math.sin(ang)*dist;
    const pz = playerCollider.end.z + Math.cos(ang)*dist;
    const floorPoint = floorAtXZ(px, pz);
    if (!floorPoint) continue;
    const forwardHint = new THREE.Vector3(Math.sin(ang), 0, Math.cos(ang)).negate();
    if (spawnAtPosition(floorPoint, forwardHint)) return true;
  }
  return false;
}
function spawnNPCGlobal(){
  if (!worldBounds) return false;
  const tries = 6;
  for (let i=0;i<tries;i++){
    const x = THREE.MathUtils.randFloat(worldBounds.min.x, worldBounds.max.x);
    const z = THREE.MathUtils.randFloat(worldBounds.min.z, worldBounds.max.z);
    const p = floorAtXZ(x, z);
    if (!p) continue;
    if (p.distanceTo(playerCollider.end) < 4) continue;
    if (spawnAtPosition(p, new THREE.Vector3().subVectors(playerCollider.end, p))) return true;
  }
  return false;
}

let spawnCooldown = 0.8;

/* ===================== Player movement ===================== */
function controls(dt){
  if (gameOver) return;
  const speedDelta = dt * (playerOnFloor ? 24 : 8);

  if (keyStates['KeyW']) playerVelocity.add(getForwardVector().multiplyScalar(speedDelta));
  if (keyStates['KeyS']) playerVelocity.add(getForwardVector().multiplyScalar(-speedDelta));
  if (keyStates['KeyA']) playerVelocity.add(getSideVector().multiplyScalar(-speedDelta));
  if (keyStates['KeyD']) playerVelocity.add(getSideVector().multiplyScalar(speedDelta));
  if (playerOnFloor && keyStates['Space']) playerVelocity.y = 15;
}

function playerCollisions(){
  const res = worldOctree.capsuleIntersect(playerCollider);
  playerOnFloor = false;
  if (res){
    playerOnFloor = res.normal.y > 0;
    if (!playerOnFloor){
      playerVelocity.addScaledVector(res.normal, -res.normal.dot(playerVelocity));
    }
    if (res.depth >= 1e-10){
      playerCollider.translate(res.normal.multiplyScalar(res.depth));
    }
  }
}

function updatePlayer(dt){
  let damping = Math.exp(-4 * dt) - 1;
  if (!playerOnFloor){ playerVelocity.y -= GRAVITY * dt; damping *= 0.1; }
  playerVelocity.addScaledVector(playerVelocity, damping);

  const deltaPos = playerVelocity.clone().multiplyScalar(dt);
  playerCollider.translate(deltaPos);
  playerCollisions();
  camera.position.copy(playerCollider.end);
}

function getForwardVector(){
  camera.getWorldDirection(playerDirection);
  playerDirection.y = 0;
  playerDirection.normalize();
  return playerDirection;
}
function getSideVector(){
  camera.getWorldDirection(playerDirection);
  playerDirection.y = 0;
  playerDirection.normalize();
  playerDirection.cross(camera.up);
  return playerDirection;
}

function teleportPlayerIfOob(){
  if (camera.position.y <= -25){
    playerCollider.start.set(0, 0.35, 0);
    playerCollider.end.set(0, 1.00, 0);
    playerCollider.radius = 0.35;
    camera.position.copy(playerCollider.end);
    camera.rotation.set(0,0,0);
    playerVelocity.set(0,0,0);
  }
}

/* ===================== Score & Timer ===================== */
let score = 0;
const WIN_KILLS = 10;
const GAME_DURATION = 180; // 3 minutos
let timeLeft = GAME_DURATION;

const hudKills = document.createElement('div');
hudKills.style.cssText = `
  position:fixed; right:12px; top:172px; z-index:11;
  font-family:system-ui,-apple-system,Segoe UI,Roboto; font-weight:700;
  color:#fff; text-shadow:0 2px 4px rgba(0,0,0,.6); font-size:18px;
`;
hudKills.textContent = 'Kills: 0 / 10';
document.body.appendChild(hudKills);

const hudTimer = document.createElement('div');
hudTimer.style.cssText = `
  position:fixed; left:50%; transform:translateX(-50%); top:12px; z-index:11;
  font-family:system-ui,-apple-system,Segoe UI,Roboto; font-weight:800;
  color:#fff; text-shadow:0 2px 6px rgba(0,0,0,.7); font-size:22px;
`;
document.body.appendChild(hudTimer);

const banner = document.createElement('div');
banner.style.cssText = `
  position:fixed; inset:0; display:none; align-items:center; justify-content:center; z-index:12;
  background:rgba(0,0,0,.35); font-family:system-ui; font-weight:900; color:#fff; 
  text-shadow:0 4px 10px rgba(0,0,0,.8); font-size:48px; letter-spacing:1px;
`;
document.body.appendChild(banner);

function formatTime(t){
  const m = Math.floor(t/60);
  const s = Math.floor(t%60);
  return `${m}:${s.toString().padStart(2,'0')}`;
}
hudTimer.textContent = formatTime(timeLeft);

function addKill(){
  if (gameOver) return;
  score++;
  hudKills.textContent = `Kills: ${score} / ${WIN_KILLS}`;
  if (score >= WIN_KILLS){
    youWon = true;
    playSfx(AUDIO_WIN, 0.9);
    endGame('¡GANASTE!');
  }
}

function endGame(message){
  if (gameOver) return;
  gameOver = true;
  if (!youWon) playSfx(AUDIO_LOSE, 0.9);
  banner.textContent = `${message}\n(Pulsa R para reiniciar)`;
  banner.style.whiteSpace = 'pre-line';
  banner.style.display = 'flex';
  setTimeout(()=> banner.style.display = 'none', 3000);
}

/* ======= Reinicio (R) ======= */
function requestRestart(){
  score = 0;
  timeLeft = GAME_DURATION;
  hudKills.textContent = `Kills: ${score} / ${WIN_KILLS}`;
  hudTimer.textContent = formatTime(timeLeft);
  gameOver = false;
  youWon = false;

  for (const npc of NPCS){
    if (npc._flashLight) scene.remove(npc._flashLight);
    cellRemove(npc.group.position);
    scene.remove(npc.group);
  }
  NPCS.length = 0;
  cellCounts.clear();

  for (const s of spheres){
    s.collider.center.set(0,-100,0);
    s.velocity.set(0,0,0);
    s.active = false;
    s.hitCooldown = 0;
    s.mesh.position.copy(s.collider.center);
    if (s.light){ s.light.visible=false; }
    if (s.flame){ s.flame.visible=false; }
  }
  sphereIdx = 0;

  playerCollider.start.set(0, 0.35, 0);
  playerCollider.end.set(0, 1.00, 0);
  playerCollider.radius = 0.35;
  camera.position.copy(playerCollider.end);
  camera.rotation.set(0,0,0);
  playerVelocity.set(0,0,0);

  banner.textContent = '¡Reiniciado!';
  banner.style.display = 'flex';
  setTimeout(()=> banner.style.display = 'none', 800);
}

/* ===================== Balls (impacto + fuego) ===================== */
function throwBall(){
  if (gameOver) return;
  const s = spheres[sphereIdx];
  camera.getWorldDirection(playerDirection);

  s.collider.center.copy(playerCollider.end)
    .addScaledVector(playerDirection, playerCollider.radius * 1.5);

  const impulse = 16 + 26 * (1 - Math.exp((mouseTime - performance.now()) * 0.001));
  s.velocity.copy(playerDirection).multiplyScalar(impulse);
  s.velocity.addScaledVector(playerVelocity, 2);
  s.active = true;
  s.hitCooldown = 0.08;

  if (!FAST_MODE){
    if (s.light){
      s.light.visible = true;
      s.light.intensity = 1.2;
      s.light.distance = 3.5;
    }
    if (s.flame){
      s.flame.visible = true;
      s.flame.scale.setScalar(0.9);
      s.flame.material.opacity = 0.9;
    }
  }

  sphereIdx = (sphereIdx + 1) % spheres.length;
}

function playEmoteWithCrossFade(npc, clip){
  npc.state = 'emote';
  const look = camera.position.clone(); look.y = npc.group.position.y;
  npc.group.lookAt(look);
  npc.dir.copy(look.clone().sub(npc.group.position).setY(0).normalize());

  const light = new THREE.PointLight(0x66ffaa, 1.0, 4.5, 1.5);
  light.position.copy(npc.group.position).add(new THREE.Vector3(0, 1.3, 0));
  scene.add(light);
  npc._flashLight = light;

  const choices = AUDIO_EMOTES.filter(n => audioBuffers.has(n));
  if (choices.length) playSfx(choices[Math.floor(Math.random()*choices.length)], 0.9);

  const emoteAction = npc.mixer.clipAction(clip, npc.group);
  emoteAction.reset().setLoop(THREE.LoopOnce, 1);
  emoteAction.clampWhenFinished = true;

  if (npc.currentAction && npc.currentAction !== emoteAction){
    emoteAction.crossFadeFrom(npc.currentAction, 0.12, false);
  }
  emoteAction.play();
  npc.currentAction = emoteAction;

  const onFinish = () => {
    addKill();
    npc.state = 'dead';
    npc.ttl = 0.3;
    emoteAction.getMixer().removeEventListener('finished', onFinish);
  };
  emoteAction.getMixer().addEventListener('finished', onFinish);
}

function tryHitNPCWithSphere(s){
  if (!s.active || gameOver) return;
  if (s.hitCooldown > 0) return;

  const speed2 = s.velocity.lengthSq();
  if (speed2 < 1.2) { s.active = false; return; }

  const c = s.collider.center;

  for (const npc of NPCS){
    if (npc.state !== 'idle') continue;

    const r = (npc.radius + SPHERE_RADIUS + 0.12);
    if (npc.group.position.distanceToSquared(c) > (r*r)) continue;

    const normal = v1.subVectors(c, npc.group.position).normalize();
    const vproj = v2.copy(normal).multiplyScalar(normal.dot(s.velocity));
    s.velocity.addScaledVector(vproj, -2);
    s.hitCooldown = 0.12;

    const disponibles = [...npcClips.keys()];
    if (!disponibles.length){ npc.state='dead'; npc.ttl=0.2; break; }
    const name = disponibles[Math.floor(Math.random()*disponibles.length)];
    const clip = npcClips.get(name);
    playEmoteWithCrossFade(npc, clip);
    break;
  }
}

function spheresCollisions(){
  for (let i=0;i<spheres.length;i++){
    const s1 = spheres[i];
    for (let j=i+1;j<spheres.length;j++){
      const s2 = spheres[j];
      const d2 = s1.collider.center.distanceToSquared(s2.collider.center);
      const r  = s1.collider.radius + s2.collider.radius;
      if (d2 < r*r){
        const normal = v1.subVectors(s1.collider.center, s2.collider.center).normalize();
        const vA = v2.copy(normal).multiplyScalar(normal.dot(s1.velocity));
        const vB = v3.copy(normal).multiplyScalar(normal.dot(s2.velocity));
        s1.velocity.add(vB).sub(vA);
        s2.velocity.add(vA).sub(vB);
        const d = (r - Math.sqrt(d2)) / 2;
        s1.collider.center.addScaledVector(normal, d);
        s2.collider.center.addScaledVector(normal, -d);
      }
    }
  }
}

function updateSpheres(dt){
  for (const s of spheres){
    if (s.hitCooldown > 0) s.hitCooldown -= dt;

    s.collider.center.addScaledVector(s.velocity, dt);

    const res = worldOctree.sphereIntersect(s.collider);
    if (res){
      s.velocity.addScaledVector(res.normal, -res.normal.dot(s.velocity) * 1.25);
      s.collider.center.add(res.normal.multiplyScalar(res.depth));
    } else {
      s.velocity.y -= GRAVITY * dt;
    }

    const damping = Math.exp(-1.4 * dt) - 1;
    s.velocity.addScaledVector(s.velocity, damping);

    if (s.velocity.lengthSq() < 0.4) {
      s.active = false;
      if (s.light) s.light.visible = false;
      if (s.flame) s.flame.visible = false;
    }

    s.flickerT += dt*10;
    const flick = 0.85 + 0.25*Math.abs(Math.sin(s.flickerT*0.7)) + 0.15*Math.random();
    s.mesh.material.emissiveIntensity = 0.8 * flick;

    if (s.light){
      s.light.visible = s.active;
      s.light.intensity = 0.9 * flick;
      s.light.position.copy(s.collider.center);
    }
    if (s.flame){
      s.flame.visible = s.active;
      s.flame.position.copy(s.collider.center).add(new THREE.Vector3(0, 0.05, 0));
      const sc = 0.8 + 0.4*Math.abs(Math.sin(s.flickerT*0.9));
      s.flame.scale.set(sc, sc*1.2, 1);
      s.flame.material.opacity = 0.65 * flick;
    }

    tryHitNPCWithSphere(s);

    s.mesh.position.copy(s.collider.center);
  }
  spheresCollisions();
}

/* ===================== NPC walking + cleanup ===================== */
function updateNPCs(dt){
  if (!gameOver){
    spawnCooldown -= dt;
    const movingForward = keyStates['KeyW'] || playerVelocity.length() > 0.15;
    if (spawnCooldown <= 0) {
      const ok =
        (movingForward && spawnNPCAhead()) ||
        spawnNPCInRing() ||
        spawnNPCGlobal();
      spawnCooldown = ok ? 0.8 : 0.3;
    }
  }

  const playerPos = playerCollider.end.clone();

  for (let i = NPCS.length - 1; i >= 0; i--){
    const npc = NPCS[i];

    if (npc.state === 'idle') {
      // ====== Perseguir al jugador (seek) ======
      const toPlayer = playerPos.clone().sub(npc.group.position).setY(0);
      const distToPlayer = toPlayer.length();
      if (distToPlayer > 0.001) toPlayer.normalize();

      // Mantenerse centrados en el pasillo
      npc.senseTimer -= dt;
      if (npc.senseTimer <= 0) {
        const sideRight = new THREE.Vector3(toPlayer.z, 0, -toPlayer.x);
        const dRight = castHorizontalDistance(npc.group.position, sideRight, 1.5);
        const dLeft  = castHorizontalDistance(npc.group.position, sideRight.clone().multiplyScalar(-1), 1.5);
        npc._lateralOffset = THREE.MathUtils.clamp((dRight - dLeft)*0.25, -0.5, 0.5);
        npc.senseTimer = 0.18 + Math.random()*0.08;
      }

      // Evitar pared frontal (gira)
      const fwdDist = castHorizontalDistance(npc.group.position, toPlayer, 0.9);
      if (fwdDist < 0.35) {
        const right = new THREE.Vector3(toPlayer.z, 0, -toPlayer.x);
        const left  = right.clone().multiplyScalar(-1);
        const dR = castHorizontalDistance(npc.group.position, right, 1.0);
        const dL = castHorizontalDistance(npc.group.position, left,  1.0);
        toPlayer.copy(dR > dL ? right : left).normalize();
      }

      // Velocidad: base + boost si te tiene a la vista
      const speed = npc.speed + (NPC_CHASE_BOOST * Math.min(1, 10/(1+distToPlayer)));

      // Movimiento (hacia ti + centrado)
      const sideRight = new THREE.Vector3(toPlayer.z, 0, -toPlayer.x);
      const lateral = sideRight.multiplyScalar(npc._lateralOffset || 0);
      const move = toPlayer.clone().multiplyScalar(speed * dt).add(lateral.multiplyScalar(dt));
      const nextXZ = npc.group.position.clone().add(move);

      const p = floorAtXZ(nextXZ.x, nextXZ.z) || floorAtXZ(npc.group.position.x, npc.group.position.z);
      if (p) npc.group.position.copy(p);

      npc.group.rotation.y = Math.atan2(toPlayer.x, toPlayer.z);

      // Perder si te alcanzan
      if (!gameOver && distToPlayer <= NPC_LOSE_DISTANCE){
        endGame('¡TE ATRAPARON!');
      }

      // ---------- Unstuck runtime ----------
      // 1) Corrige penetración si existe
      const collided = resolveNPCCollision(npc);
      if (collided) {
        recentreInCorridor(npc, toPlayer);
      }

      // 2) Detecta si casi no avanzó en 0.6s => girar y empujar
      const moved = npc._lastPos.distanceToSquared(npc.group.position);
      if (moved < 0.0009) npc._stuckTime += dt; else npc._stuckTime = 0;
      if (npc._stuckTime > 0.6){
        // gira 60–120 grados y empuja al centro
        const angle = THREE.MathUtils.degToRad(60 + Math.random()*60) * (Math.random()<0.5?-1:1);
        toPlayer.applyAxisAngle(new THREE.Vector3(0,1,0), angle).normalize();
        npc.group.rotation.y = Math.atan2(toPlayer.x, toPlayer.z);
        npc.group.position.add(toPlayer.clone().multiplyScalar(0.2));
        recentreInCorridor(npc, toPlayer);
        npc._stuckTime = 0;
      }
      npc._lastPos.copy(npc.group.position);
    }

    if (npc.mixer) npc.mixer.update(dt);

    // Solo descontar TTL si está "dead"
    if (npc.state !== 'idle') npc.ttl -= dt;

    if (npc._flashLight){
      npc._flashLight.position.copy(npc.group.position).add(new THREE.Vector3(0, 1.3, 0));
      if (npc.state === 'dead'){ scene.remove(npc._flashLight); npc._flashLight = null; }
    }

    const far = npc.group.position.distanceTo(playerCollider.end) > 60;
    if (npc.state === 'dead' || npc.ttl <= 0 || far){
      if (npc._flashLight){ scene.remove(npc._flashLight); npc._flashLight = null; }
      cellRemove(npc.group.position);
      scene.remove(npc.group);
      NPCS.splice(i, 1);
    }
  }
}

/* ===================== Radar ===================== */
const RADAR_SIZE = 150;
const RADAR_RANGE = 20;
const RADAR_SCALE = RADAR_SIZE / (2 * RADAR_RANGE);

const radar = document.createElement('canvas');
radar.width = radar.height = RADAR_SIZE;
radar.style.cssText = `
  position:fixed; right:12px; top:12px; z-index:10;
  background: rgba(0,0,0,.45); border:1px solid rgba(255,255,255,.25);
  border-radius:8px;
`;
document.body.appendChild(radar);
const rctx = radar.getContext('2d');

function drawRadar(){
  const cx = RADAR_SIZE/2, cy = RADAR_SIZE/2;
  rctx.clearRect(0,0,RADAR_SIZE,RADAR_SIZE);

  rctx.strokeStyle = 'rgba(255,255,255,.2)';
  rctx.beginPath(); rctx.arc(cx, cy, cx-6, 0, Math.PI*2); rctx.stroke();

  const dir = getForwardVector().clone().normalize();
  const yaw = Math.atan2(dir.x, dir.z);

  rctx.fillStyle = '#fff';
  rctx.save();
  rctx.translate(cx, cy);
  rctx.rotate(-yaw);
  rctx.beginPath();
  rctx.moveTo(0, -8);
  rctx.lineTo(5, 6);
  rctx.lineTo(-5, 6);
  rctx.closePath();
  rctx.fill();
  rctx.restore();

  let nearest = null;
  let nearestD2 = Infinity;

  for (const npc of NPCS){
    if (npc.state === 'dead') continue;
    const dx = npc.group.position.x - playerCollider.end.x;
    const dz = npc.group.position.z - playerCollider.end.z;

    const rx =  dx * Math.cos(-yaw) - dz * Math.sin(-yaw);
    const rz =  dx * Math.sin(-yaw) + dz * Math.cos(-yaw);

    const dist = Math.hypot(rx, rz);
    if (dist > RADAR_RANGE) continue;

    const x = cx + rx * RADAR_SCALE;
    const y = cy + rz * RADAR_SCALE;

    rctx.fillStyle = '#ff4040';
    rctx.beginPath(); rctx.arc(x, y, 3, 0, Math.PI*2); rctx.fill();

    const d2 = rx*rx + rz*rz;
    if (d2 < nearestD2){ nearestD2 = d2; nearest = {x,y}; }
  }

  if (nearest){
    rctx.strokeStyle = 'rgba(255,255,255,.6)';
    rctx.beginPath(); rctx.moveTo(cx, cy); rctx.lineTo(nearest.x, nearest.y); rctx.stroke();
  }
}

/* ===================== Animate ===================== */
let _radarFrame = 0;

function animate(){
  const rawDt = clock.getDelta();

  if (!gameOver){
    timeLeft = Math.max(0, timeLeft - rawDt);
    hudTimer.textContent = formatTime(timeLeft);
    if (timeLeft <= 0 && !youWon){
      endGame('¡PERDISTE!');
    }
  }

  const dt = Math.min(0.05, rawDt) / STEPS_PER_FRAME;

  for (let i=0;i<STEPS_PER_FRAME;i++){
    controls(dt);
    updatePlayer(dt);
    updateSpheres(dt);
    updateNPCs(dt);
    teleportPlayerIfOob();
  }

  renderer.render(scene, camera);
  stats.update();

  if ((_radarFrame++ & 1) === 0) drawRadar();
}

