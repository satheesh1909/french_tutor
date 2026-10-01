"use client";

import { useEffect, useRef } from "react";
import type { StageState } from "./AvatarStage";
import type { LevelRef } from "./voice";

/**
 * Charlotte's head, in 3D. Her jaw and lips follow the audio she is speaking, she blinks, breathes
 * and looks around, and her expression follows what the app is doing.
 *
 * Two kinds of head:
 *  - the built-in sculpted one (no download, works offline), or
 *  - any .glb with morph targets, such as a Ready Player Me avatar, set in Settings. Those carry
 *    ARKit blend shapes (jawOpen, mouthSmile, eyeBlink...), which get the same signals.
 *
 * Lip-sync comes from the audio itself: loudness opens the jaw, and the balance between low and
 * high frequencies decides whether the mouth is round ("ooh") or wide ("eee").
 */
export function Avatar3D({
  state,
  level,
  modelUrl,
  onModelError,
}: {
  state: StageState;
  level: LevelRef;
  modelUrl?: string;
  onModelError?: (message: string) => void;
}) {
  const mount = useRef<HTMLDivElement>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const errorRef = useRef(onModelError);
  errorRef.current = onModelError;

  useEffect(() => {
    const host = mount.current;
    if (!host) return;
    let disposed = false;
    let cleanup = () => {};

    void (async () => {
      const THREE = await import("three");
      if (disposed) return;

      const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.05;
      host.appendChild(renderer.domElement);
      renderer.domElement.style.width = "100%";
      renderer.domElement.style.height = "100%";
      renderer.domElement.style.display = "block";

      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(26, 1, 0.1, 100);
      camera.position.set(0, 0.04, 4.5);
      camera.lookAt(0, 0.02, 0);

      // Soft indoor lighting: warm key, cool fill, and a rim to lift her off the background.
      const key = new THREE.DirectionalLight(0xfff1e0, 2.4);
      key.position.set(1.6, 2.1, 2.6);
      const fill = new THREE.DirectionalLight(0xd9e6ff, 0.85);
      fill.position.set(-2.2, 0.4, 1.4);
      const rim = new THREE.DirectionalLight(0xffd9c0, 1.5);
      rim.position.set(-0.8, 1.2, -2.2);
      scene.add(key, fill, rim, new THREE.HemisphereLight(0xffffff, 0x4a4033, 0.75));

      const root = new THREE.Group();
      scene.add(root);

      const rig = modelUrl ? await loadModel(THREE, modelUrl, root, errorRef.current) : null;
      const sculpt = rig ? null : buildHead(THREE, root);
      if (disposed) return;

      // ----- animation -----
      const clock = new THREE.Clock();
      let jaw = 0;
      let wide = 0;
      let blink = 0;
      let nextBlink = 1.5;
      let elapsed = 0;
      let lookX = 0;
      let lookY = 0;
      let targetX = 0;
      let targetY = 0;
      let nextGlance = 2;
      let raf = 0;

      const render = () => {
        raf = requestAnimationFrame(render);
        const dt = Math.min(clock.getDelta(), 0.05);
        elapsed += dt;
        const speaking = stateRef.current === "speaking";
        const listening = stateRef.current === "listening" || stateRef.current === "hearing";
        const thinking = stateRef.current === "thinking" || stateRef.current === "transcribing";

        // Jaw follows the voice: opens quickly, closes a little more slowly, like a real mouth.
        const loud = speaking ? Math.min(1, (level.open ?? level.current) * 1.35) : 0;
        jaw += (loud - jaw) * (loud > jaw ? 0.55 : 0.22);
        const wideTarget = speaking ? Math.min(1, level.wide ?? 0.35) : 0;
        wide += (wideTarget - wide) * 0.2;

        // Blinking, with a double blink now and then.
        nextBlink -= dt;
        if (nextBlink <= 0) {
          blink = 1;
          nextBlink = 2.2 + Math.random() * 4 + (Math.random() < 0.15 ? -1.9 : 0);
        }
        blink = Math.max(0, blink - dt * 7.5);
        const lid = Math.sin(Math.min(1, blink) * Math.PI);

        // Where she is looking: at you while speaking, up and away while thinking.
        nextGlance -= dt;
        if (nextGlance <= 0) {
          targetX = (Math.random() - 0.5) * (listening ? 0.12 : 0.3);
          targetY = (Math.random() - 0.5) * 0.18 + (thinking ? 0.34 : 0);
          nextGlance = thinking ? 0.8 + Math.random() : 1.6 + Math.random() * 3;
        }
        lookX += (targetX - lookX) * 0.06;
        lookY += (targetY - lookY) * 0.06;

        const breathe = Math.sin(elapsed * 1.1) * 0.012;
        const sway = Math.sin(elapsed * 0.53) * 0.035 + Math.sin(elapsed * 0.27) * 0.02;
        const nod = speaking ? Math.sin(elapsed * 2.6) * 0.012 * (0.3 + jaw) : 0;
        const tilt = listening ? 0.07 : thinking ? -0.03 : 0;

        if (sculpt) sculpt.update({ jaw, wide, lid, lookX, lookY, sway, nod, breathe, tilt, listening, thinking, speaking, elapsed });
        if (rig) rig.update({ jaw, wide, lid, lookX, lookY, sway, nod, breathe, tilt });

        renderer.render(scene, camera);
      };
      render();

      const resize = () => {
        const { clientWidth: w, clientHeight: h } = host;
        if (!w || !h) return;
        renderer.setSize(w, h, false);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
      };
      resize();
      const observer = new ResizeObserver(resize);
      observer.observe(host);

      // Don't burn a GPU while the window is in the background.
      const visibility = () => {
        if (document.hidden) cancelAnimationFrame(raf);
        else {
          clock.getDelta();
          render();
        }
      };
      document.addEventListener("visibilitychange", visibility);

      cleanup = () => {
        cancelAnimationFrame(raf);
        observer.disconnect();
        document.removeEventListener("visibilitychange", visibility);
        scene.traverse((object) => {
          const mesh = object as { geometry?: { dispose(): void }; material?: { dispose(): void } | { dispose(): void }[] };
          mesh.geometry?.dispose();
          if (Array.isArray(mesh.material)) mesh.material.forEach((m) => m.dispose());
          else mesh.material?.dispose();
        });
        renderer.dispose();
        renderer.domElement.remove();
      };
    })();

    return () => {
      disposed = true;
      cleanup();
    };
  }, [modelUrl, level]);

  return <div ref={mount} className="stage__canvas" aria-hidden="true" />;
}

type Frame = {
  jaw: number;
  wide: number;
  lid: number;
  lookX: number;
  lookY: number;
  sway: number;
  nod: number;
  breathe: number;
  tilt: number;
  listening?: boolean;
  thinking?: boolean;
  speaking?: boolean;
  elapsed?: number;
};

type ThreeModule = typeof import("three");

// ---------------------------------------------------------------------------
// The built-in head
// ---------------------------------------------------------------------------

const SKIN = 0xf2c6a8;
const HAIR = 0x4a2f22;
const LIP = 0xc2706a;

function buildHead(THREE: ThreeModule, root: import("three").Object3D) {
  const head = new THREE.Group();
  head.position.y = 0.06;
  root.add(head);

  const skin = new THREE.MeshStandardMaterial({ color: SKIN, roughness: 0.68, metalness: 0 });
  const hairMaterial = new THREE.MeshStandardMaterial({ color: HAIR, roughness: 0.55, metalness: 0.05 });

  // Skull. The jaw is not a separate mesh: vertices below the mouth rotate around a jaw hinge in
  // the vertex shader, so the chin moves without a seam.
  const skull = new THREE.Mesh(new THREE.SphereGeometry(1, 96, 96), skin);
  skull.scale.set(0.82, 1.0, 0.88);
  const jawUniform = { value: 0 };
  const wideUniform = { value: 0 };
  skin.onBeforeCompile = (shader) => {
    shader.uniforms.uJaw = jawUniform;
    shader.uniforms.uWide = wideUniform;
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        `#include <common>
         uniform float uJaw;
         uniform float uWide;`,
      )
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
         float jawWeight = smoothstep(-0.02, -0.92, transformed.y);
         float angle = uJaw * 0.30 * jawWeight;
         vec3 hinge = vec3(0.0, -0.08, -0.35);
         vec3 rel = transformed - hinge;
         float c = cos(angle), s = sin(angle);
         transformed = hinge + vec3(rel.x, rel.y * c - rel.z * s, rel.y * s + rel.z * c);
         // A wide "eee" pulls the cheeks out a touch; a round "ooh" narrows them.
         transformed.x *= 1.0 + (uWide - 0.4) * 0.05 * jawWeight;`,
      );
  };
  head.add(skull);

  // Lips, sitting on the face. The lower one rides the jaw.
  const lipMaterial = new THREE.MeshStandardMaterial({ color: LIP, roughness: 0.45 });
  const upperLip = new THREE.Mesh(new THREE.SphereGeometry(0.15, 48, 24), lipMaterial);
  upperLip.scale.set(1, 0.3, 0.42);
  upperLip.position.set(0, -0.3, 0.8);
  const lowerLip = new THREE.Mesh(new THREE.SphereGeometry(0.15, 48, 24), lipMaterial);
  lowerLip.scale.set(0.96, 0.34, 0.42);
  lowerLip.position.set(0, -0.37, 0.79);
  const mouthCavity = new THREE.Mesh(new THREE.SphereGeometry(0.13, 32, 24), new THREE.MeshStandardMaterial({ color: 0x3a1218, roughness: 0.9 }));
  mouthCavity.scale.set(1, 0.1, 0.35);
  mouthCavity.position.set(0, -0.34, 0.76);
  head.add(upperLip, lowerLip, mouthCavity);

  // Nose.
  const nose = new THREE.Mesh(new THREE.SphereGeometry(0.1, 32, 32), skin);
  nose.scale.set(0.62, 0.85, 0.75);
  nose.position.set(0, -0.12, 0.84);
  head.add(nose);

  // Eyes: white, iris, pupil, and a highlight that makes them look alive.
  const eyeWhite = new THREE.MeshStandardMaterial({ color: 0xfbf7f4, roughness: 0.25 });
  const iris = new THREE.MeshStandardMaterial({ color: 0x4a6b52, roughness: 0.3, metalness: 0.1 });
  const pupil = new THREE.MeshStandardMaterial({ color: 0x140f0c, roughness: 0.2 });
  const glint = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const eyes: import("three").Group[] = [];
  const lids: import("three").Mesh[] = [];
  const brows: import("three").Mesh[] = [];

  for (const side of [-1, 1]) {
    const socket = new THREE.Group();
    socket.position.set(side * 0.26, 0.13, 0.78);
    const ball = new THREE.Mesh(new THREE.SphereGeometry(0.115, 32, 32), eyeWhite);
    ball.scale.z = 0.72;
    const eye = new THREE.Group();
    const irisMesh = new THREE.Mesh(new THREE.SphereGeometry(0.055, 24, 24), iris);
    irisMesh.scale.z = 0.45;
    irisMesh.position.z = 0.082;
    const pupilMesh = new THREE.Mesh(new THREE.SphereGeometry(0.026, 20, 20), pupil);
    pupilMesh.scale.z = 0.4;
    pupilMesh.position.z = 0.1;
    const glintMesh = new THREE.Mesh(new THREE.SphereGeometry(0.012, 12, 12), glint);
    glintMesh.position.set(0.022, 0.024, 0.108);
    eye.add(irisMesh, pupilMesh, glintMesh);
    socket.add(ball, eye);
    eyes.push(eye);

    // Eyelid: a skin-coloured cap that swings down over the eye.
    const lidMesh = new THREE.Mesh(new THREE.SphereGeometry(0.128, 32, 20, 0, Math.PI * 2, 0, Math.PI / 2), skin);
    lidMesh.scale.z = 0.8;
    socket.add(lidMesh);
    lids.push(lidMesh);

    const brow = new THREE.Mesh(new THREE.CapsuleGeometry(0.022, 0.17, 6, 12), hairMaterial);
    brow.rotation.z = Math.PI / 2 + side * 0.12;
    brow.position.set(side * 0.26, 0.33, 0.82);
    brow.scale.z = 0.55;
    head.add(brow);
    brows.push(brow);
    head.add(socket);
  }

  // Hair: a cap over the skull plus a bob at the sides.
  const cap = new THREE.Mesh(new THREE.SphereGeometry(1.02, 64, 48, 0, Math.PI * 2, 0, Math.PI * 0.42), hairMaterial);
  cap.scale.set(0.87, 1.03, 0.94);
  cap.position.y = 0.05;
  head.add(cap);
  for (const side of [-1, 1]) {
    const bob = new THREE.Mesh(new THREE.SphereGeometry(0.42, 40, 40), hairMaterial);
    bob.scale.set(0.55, 1.15, 0.8);
    bob.position.set(side * 0.72, -0.25, -0.05);
    head.add(bob);
  }
  const backHair = new THREE.Mesh(new THREE.SphereGeometry(0.92, 48, 48), hairMaterial);
  backHair.scale.set(0.86, 0.98, 0.72);
  backHair.position.set(0, -0.06, -0.3);
  head.add(backHair);

  // Neck and shoulders, so she isn't a floating head.
  const body = new THREE.Group();
  body.position.y = -1.02;
  root.add(body);
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.29, 0.34, 0.5, 32), skin);
  neck.position.y = 0.22;
  const collar = new THREE.MeshStandardMaterial({ color: 0x33506f, roughness: 0.85 });
  const shoulders = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 32, 0, Math.PI * 2, 0, Math.PI / 2), collar);
  shoulders.scale.set(0.95, 0.62, 0.62);
  shoulders.position.y = -0.36;
  body.add(neck, shoulders);

  return {
    update(f: Frame) {
      jawUniform.value = f.jaw;
      wideUniform.value = f.wide;

      head.rotation.set(-f.lookY * 0.25 + f.nod, f.sway + f.lookX * 0.5, f.tilt * 0.5);
      head.position.y = 0.06 + f.breathe;
      body.scale.setScalar(1 + f.breathe * 0.35);

      lowerLip.position.y = -0.37 - f.jaw * 0.22;
      lowerLip.scale.x = 0.96 - f.wide * 0.05 + f.jaw * 0.02;
      upperLip.scale.x = 1 + f.wide * 0.06;
      mouthCavity.scale.y = 0.1 + f.jaw * 1.5;
      mouthCavity.scale.x = 1 - f.wide * 0.12 + f.jaw * 0.06;
      mouthCavity.position.y = -0.34 - f.jaw * 0.1;

      for (const eye of eyes) {
        eye.position.x = f.lookX * 0.05;
        eye.position.y = f.lookY * 0.04;
      }
      for (const lidMesh of lids) {
        // Open: tucked up behind the brow. Closed: rotated down over the eye.
        lidMesh.rotation.x = -0.55 + f.lid * 2.15;
      }
      brows.forEach((brow, i) => {
        const side = i === 0 ? -1 : 1;
        const lift = f.thinking ? 0.05 : f.listening ? 0.02 : 0;
        brow.position.y = 0.3 + lift + f.jaw * 0.01;
        brow.rotation.z = Math.PI / 2 + side * (0.12 + (f.thinking ? 0.06 : 0));
      });
    },
  };
}

// ---------------------------------------------------------------------------
// A downloaded .glb head (Ready Player Me and friends)
// ---------------------------------------------------------------------------

/** Blend shapes these avatars normally carry, in the order we prefer them. */
const MORPHS = {
  jaw: ["jawOpen", "mouthOpen", "viseme_aa", "JawOpen"],
  wide: ["mouthSmile", "mouthSmileLeft", "viseme_I", "mouthStretchLeft"],
  round: ["mouthFunnel", "mouthPucker", "viseme_O", "viseme_U"],
  blink: ["eyeBlinkLeft", "eyesClosed", "eyeBlink_L", "blink"],
  blinkRight: ["eyeBlinkRight", "eyeBlink_R"],
};

async function loadModel(THREE: ThreeModule, url: string, root: import("three").Object3D, onError?: (message: string) => void) {
  try {
    const { GLTFLoader } = await import("three/examples/jsm/loaders/GLTFLoader.js");
    const gltf = await new GLTFLoader().loadAsync(url);
    const model = gltf.scene;

    const targets: { mesh: import("three").Mesh; index: number; kind: keyof typeof MORPHS }[] = [];
    let head: import("three").Object3D | null = null;
    model.traverse((object) => {
      if (object.name === "Head" || object.name === "head" || object.name.endsWith("_Head")) head = head ?? object;
      const mesh = object as import("three").Mesh;
      if (!mesh.morphTargetDictionary || !mesh.morphTargetInfluences) return;
      for (const kind of Object.keys(MORPHS) as (keyof typeof MORPHS)[]) {
        for (const name of MORPHS[kind]) {
          const index = mesh.morphTargetDictionary[name];
          if (index !== undefined) {
            targets.push({ mesh, index, kind });
            break;
          }
        }
      }
    });

    // Frame the head: sit the camera where the face is, whatever the model's scale.
    const box = new THREE.Box3().setFromObject(model);
    const size = box.getSize(new THREE.Vector3());
    const top = box.max.y;
    const scale = 2.6 / Math.max(size.y, 0.001);
    model.scale.setScalar(scale);
    model.position.y = -(top * scale) + 1.18;
    root.add(model);

    if (targets.length === 0) {
      onError?.("That model has no mouth blend shapes, so she can't lip-sync with it. A Ready Player Me avatar does.");
    }

    const set = (kind: keyof typeof MORPHS, value: number) => {
      for (const t of targets) if (t.kind === kind) t.mesh.morphTargetInfluences![t.index] = value;
    };

    return {
      update(f: Frame) {
        set("jaw", Math.min(1, f.jaw));
        set("wide", Math.min(0.7, f.wide * 0.7));
        set("round", Math.min(0.6, (1 - f.wide) * f.jaw * 0.6));
        set("blink", f.lid);
        set("blinkRight", f.lid);
        const target = (head ?? model) as import("three").Object3D;
        target.rotation.set(-f.lookY * 0.2 + f.nod, f.sway + f.lookX * 0.4, f.tilt * 0.4);
        model.position.y = -(top * scale) + 1.18 + f.breathe;
      },
    };
  } catch (err) {
    onError?.(err instanceof Error ? `That avatar wouldn't load: ${err.message}` : "That avatar wouldn't load.");
    return null;
  }
}
