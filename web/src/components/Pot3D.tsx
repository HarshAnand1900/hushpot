"use client";

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";

import styles from "./Pot3D.module.css";

/**
 * The pot — ported from the v5 design prototype's `init3D`, geometry and materials kept
 * to the original numbers rather than reinterpreted.
 *
 * Two dressings of the same object:
 *   - `variant="exhibit"` (landing) puts it on a plinth under a spotlight, behind a
 *     swagged chain rope, with sealed ciphertext plates orbiting it. It reads as a thing
 *     on display, which is the point: a pot everyone can look at and nobody can open.
 *   - `variant="solo"` (Pool tab) is the object alone, no set.
 *
 * Two details carry most of the look and are worth not "simplifying":
 *   - the gold is a generated texture with hex ciphertext bands and veining baked into
 *     it, used as both map and bump. Plain gold looks like a different object entirely.
 *   - the environment is a hand-painted gradient canvas, not a room probe. Metal at
 *     metalness 1 renders black without something to reflect, and what it reflects is
 *     most of the character.
 */

const QUIPS = [
  "",
  "it rattles.",
  "heavier than last week.",
  "nothing leaks.",
  "it still can't read itself.",
  "no one heard that.",
  "the pot keeps its mouth shut.",
  "somebody's week just got better.",
  "unreadable, and pleased about it.",
  "that one landed on a ciphertext.",
  "the chain saw a handle, nothing else.",
  "still nobody's name in there.",
];

type Variant = "exhibit" | "solo";

/** Studio reflection for the metal. */
function makeEnvTexture(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = 512;
  c.height = 256;
  const x = c.getContext("2d")!;

  const g = x.createLinearGradient(0, 0, 0, 256);
  g.addColorStop(0, "#fffaf0");
  g.addColorStop(0.3, "#e6c894");
  g.addColorStop(0.52, "#a58250");
  g.addColorStop(0.72, "#8a6a42");
  g.addColorStop(1, "#6d5433");
  x.fillStyle = g;
  x.fillRect(0, 0, 512, 256);

  // Softbox highlights — these are what read as specular streaks on the gold.
  x.fillStyle = "rgba(255,255,255,.98)";
  x.fillRect(60, 4, 170, 70);
  x.fillStyle = "rgba(255,238,200,.75)";
  x.fillRect(320, 18, 120, 52);
  x.fillStyle = "rgba(255,214,150,.45)";
  x.fillRect(0, 170, 512, 40);
  x.fillStyle = "rgba(168,150,255,.35)";
  x.fillRect(0, 132, 512, 26);

  const t = new THREE.CanvasTexture(c);
  t.mapping = THREE.EquirectangularReflectionMapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Gold engraved with veining, a mosaic band, and rows of hex ciphertext. */
function makeEngraveTexture(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = 2048;
  c.height = 1024;
  const x = c.getContext("2d")!;

  x.fillStyle = "#e8b959";
  x.fillRect(0, 0, 2048, 1024);

  x.strokeStyle = "rgba(120,84,20,.30)";
  x.lineWidth = 1.6;
  for (let k = 0; k < 90; k++) {
    const y0 = k * 11.4;
    x.beginPath();
    for (let px = 0; px <= 2048; px += 4) {
      const py = y0 + Math.sin(px * 0.011 + k * 0.42) * 7 + Math.sin(px * 0.003 + k * 0.9) * 12;
      if (px === 0) x.moveTo(px, py);
      else x.lineTo(px, py);
    }
    x.stroke();
  }

  const hex = "0123456789abcdef";
  const band = (cy: number, size: number, alpha: number) => {
    x.font = `600 ${size}px 'IBM Plex Mono', monospace`;
    x.textBaseline = "middle";
    x.fillStyle = `rgba(92,62,10,${alpha})`;
    let s = "";
    for (let i = 0; i < 460; i++) s += (i % 12 === 0 ? " 0x" : "") + hex[Math.floor(Math.random() * 16)];
    x.fillText(s, -40, cy);
  };

  x.fillStyle = "rgba(255,235,190,.30)";
  x.fillRect(0, 300, 2048, 46);
  band(324, 30, 0.72);
  x.fillStyle = "rgba(255,235,190,.24)";
  x.fillRect(0, 690, 2048, 38);
  band(710, 25, 0.6);

  x.fillStyle = "rgba(92,62,10,.42)";
  for (let gx = 0; gx < 2048; gx += 26) {
    for (let gy = 430; gy < 620; gy += 26) {
      if ((gx / 26 + gy / 26) % 3 === 0) {
        x.fillRect(gx + 6, gy + 6, 9, 9);
      } else {
        x.strokeStyle = "rgba(92,62,10,.28)";
        x.lineWidth = 1.2;
        x.strokeRect(gx + 6.5, gy + 6.5, 9, 9);
      }
    }
  }

  x.strokeStyle = "rgba(92,62,10,.55)";
  x.lineWidth = 3;
  for (const yy of [296, 348, 686, 730]) {
    x.beginPath();
    x.moveTo(0, yy);
    x.lineTo(2048, yy);
    x.stroke();
  }

  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

/**
 * The floor: radiating stone wedges, marble veining, a twelve-point rose at the centre,
 * concentric brass rings, a guilloche band, a tick ruler, hex legend and a dentil border.
 * It is most of what makes the room feel like a vault rather than a dark plane.
 */
function makeMarbleTexture(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = 2048;
  c.height = 2048;
  const x = c.getContext("2d")!;

  const g0 = x.createRadialGradient(1024, 1024, 40, 1024, 1024, 1024);
  g0.addColorStop(0, "#3b3225");
  g0.addColorStop(0.5, "#2a251d");
  g0.addColorStop(1, "#171512");
  x.fillStyle = g0;
  x.fillRect(0, 0, 2048, 2048);
  x.translate(1024, 1024);

  // Radiating stone wedges with brass separators.
  const SEG = 24;
  for (let i = 0; i < SEG; i++) {
    const a0 = (i / SEG) * 6.283;
    const a1 = ((i + 1) / SEG) * 6.283;
    x.beginPath();
    x.moveTo(0, 0);
    x.arc(0, 0, 990, a0, a1);
    x.closePath();
    x.fillStyle = i % 2 ? "rgba(255,232,190,.055)" : "rgba(0,0,0,.14)";
    x.fill();
    x.strokeStyle = "rgba(255,210,8,.30)";
    x.lineWidth = 2.6;
    x.beginPath();
    x.moveTo(Math.cos(a0) * 470, Math.sin(a0) * 470);
    x.lineTo(Math.cos(a0) * 985, Math.sin(a0) * 985);
    x.stroke();
  }

  // Marble veining.
  x.strokeStyle = "rgba(255,240,215,.055)";
  x.lineWidth = 1.6;
  for (let k = 0; k < 130; k++) {
    let px = (Math.random() - 0.5) * 2048;
    let py = (Math.random() - 0.5) * 2048;
    x.beginPath();
    x.moveTo(px, py);
    for (let s = 0; s < 7; s++) {
      px += (Math.random() - 0.5) * 200;
      py += (Math.random() - 0.5) * 200;
      x.lineTo(px, py);
    }
    x.stroke();
  }

  const ring = (r: number, w: number, a: number) => {
    x.strokeStyle = `rgba(255,210,8,${a})`;
    x.lineWidth = w;
    x.beginPath();
    x.arc(0, 0, r, 0, 6.283);
    x.stroke();
  };

  // Twelve-point rose at the centre.
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * 6.283;
    x.beginPath();
    x.moveTo(0, 0);
    x.lineTo(Math.cos(a - 0.135) * 400, Math.sin(a - 0.135) * 400);
    x.lineTo(Math.cos(a) * 418, Math.sin(a) * 418);
    x.lineTo(Math.cos(a + 0.135) * 400, Math.sin(a + 0.135) * 400);
    x.closePath();
    x.fillStyle = i % 2 ? "rgba(255,210,8,.09)" : "rgba(255,210,8,.17)";
    x.fill();
    x.strokeStyle = "rgba(255,210,8,.26)";
    x.lineWidth = 2;
    x.stroke();
  }

  ring(120, 3, 0.4);
  ring(132, 1.4, 0.24);
  ring(430, 5, 0.44);
  ring(446, 1.6, 0.24);
  ring(700, 3.4, 0.36);
  ring(714, 1.4, 0.2);
  ring(900, 2.4, 0.3);
  ring(985, 5, 0.42);
  ring(1000, 1.8, 0.24);

  // Guilloche: interlaced circles between the rings.
  x.strokeStyle = "rgba(255,210,8,.34)";
  x.lineWidth = 1.8;
  for (let i = 0; i < 72; i++) {
    const a = (i / 72) * 6.283;
    x.beginPath();
    x.arc(Math.cos(a) * 565, Math.sin(a) * 565, 62, 0, 6.283);
    x.stroke();
  }

  // Tick ruler.
  x.strokeStyle = "rgba(255,210,8,.40)";
  for (let i = 0; i < 144; i++) {
    const a = (i / 144) * 6.283;
    const r0 = i % 6 === 0 ? 714 : 862;
    x.lineWidth = i % 6 === 0 ? 3 : 1.6;
    x.beginPath();
    x.moveTo(Math.cos(a) * r0, Math.sin(a) * r0);
    x.lineTo(Math.cos(a) * 896, Math.sin(a) * 896);
    x.stroke();
  }

  // Hex legend around the outer band.
  x.font = "600 30px 'IBM Plex Mono', monospace";
  x.textAlign = "center";
  x.textBaseline = "middle";
  x.fillStyle = "rgba(255,210,8,.42)";
  const hexr = "0123456789ABCDEF";
  for (let i = 0; i < 120; i++) {
    const a = (i / 120) * 6.283;
    x.save();
    x.rotate(a + Math.PI / 2);
    x.translate(0, -945);
    x.fillText(hexr[(Math.random() * 16) | 0] + hexr[(Math.random() * 16) | 0], 0, 0);
    x.restore();
  }

  // Brass dentil border.
  for (let i = 0; i < 180; i++) {
    const a = (i / 180) * 6.283;
    x.save();
    x.rotate(a);
    x.fillStyle = i % 2 ? "rgba(255,210,8,.30)" : "rgba(255,210,8,.10)";
    x.fillRect(1002, -8, 20, 16);
    x.restore();
  }

  x.setTransform(1, 0, 0, 1, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

/**
 * The room's cyclorama: horizontal strata only, no bays or pilasters, with a warm horizon
 * wash behind the pot and an engraved motto frieze on the upper datum line.
 */
function makeWallTexture(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = 4096;
  c.height = 1024;
  const x = c.getContext("2d")!;

  const g = x.createLinearGradient(0, 1024, 0, 0);
  g.addColorStop(0, "#241d14");
  g.addColorStop(0.22, "#171a1c");
  g.addColorStop(0.55, "#0c1219");
  g.addColorStop(1, "#05080c");
  x.fillStyle = g;
  x.fillRect(0, 0, 4096, 1024);

  // Low warm horizon wash, wrapping the whole drum.
  const hz = x.createLinearGradient(0, 1024, 0, 520);
  hz.addColorStop(0, "rgba(255,210,8,.34)");
  hz.addColorStop(0.5, "rgba(255,210,8,.12)");
  hz.addColorStop(1, "rgba(255,210,8,0)");
  x.fillStyle = hz;
  x.fillRect(0, 520, 4096, 504);

  // Brushed stone courses.
  for (let y = 700; y < 1010; y += 13) {
    x.fillStyle = `rgba(255,236,200,${(0.006 + Math.random() * 0.012).toFixed(3)})`;
    x.fillRect(0, y, 4096, 1 + Math.random() * 2);
  }

  // Three brass datum lines — the only structure in the room.
  x.fillStyle = "rgba(255,210,8,.62)";
  x.fillRect(0, 286, 4096, 6);
  x.fillStyle = "rgba(255,210,8,.26)";
  x.fillRect(0, 302, 4096, 2);
  x.fillStyle = "rgba(255,210,8,.40)";
  x.fillRect(0, 952, 4096, 5);

  // Deep shadow above the datum, so the ceiling reads as unlit air.
  const top = x.createLinearGradient(0, 286, 0, 0);
  top.addColorStop(0, "rgba(0,0,0,.30)");
  top.addColorStop(1, "rgba(0,0,0,.86)");
  x.fillStyle = top;
  x.fillRect(0, 0, 4096, 286);
  x.fillStyle = "rgba(0,0,0,.58)";
  x.fillRect(0, 968, 4096, 56);

  // The motto, engraved around the drum.
  x.font = "600 15px 'IBM Plex Mono', monospace";
  x.textBaseline = "middle";
  x.textAlign = "left";
  x.fillStyle = "rgba(255,210,8,.38)";
  let line = "";
  for (let i = 0; i < 26; i++) {
    line += "  AMOUNTS ENCRYPTED · WINNER UNNAMED · ZAMA FHEVM · COMPUTED ON CIPHERTEXT ·";
  }
  x.fillText(line, 0, 326);

  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  t.repeat.x = -1;
  t.offset.x = 1;
  return t;
}

/** A slow drifting haze band across the drum — air, not glyphs. */
function makeVeilTexture(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = 1024;
  c.height = 512;
  const x = c.getContext("2d")!;

  x.fillStyle = "#000";
  x.fillRect(0, 0, 1024, 512);

  for (let i = 0; i < 26; i++) {
    const cx = Math.random() * 1024;
    const cy = 150 + Math.random() * 300;
    const rx = 120 + Math.random() * 260;
    const ry = 26 + Math.random() * 54;
    const g = x.createRadialGradient(cx, cy, 0, cx, cy, 1);
    g.addColorStop(0, `rgba(255,226,178,${(0.05 + Math.random() * 0.07).toFixed(3)})`);
    g.addColorStop(1, "rgba(255,226,178,0)");
    x.save();
    x.translate(cx, cy);
    x.scale(rx, ry);
    x.translate(-cx, -cy);
    x.fillStyle = g;
    x.fillRect(cx - 1, cy - 1, 2, 2);
    x.restore();
  }

  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(2, 1);
  return t;
}

/** A placard for a settled draw, hung flush on the wall. */
function makePlacardTexture(title: string, sub: string): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = 512;
  c.height = 256;
  const x = c.getContext("2d")!;

  x.fillStyle = "#12100b";
  x.fillRect(0, 0, 512, 256);
  x.strokeStyle = "rgba(255,210,8,.55)";
  x.lineWidth = 5;
  x.strokeRect(10, 10, 492, 236);

  x.textAlign = "center";
  x.fillStyle = "rgba(255,210,8,.92)";
  x.font = "700 70px 'IBM Plex Mono', monospace";
  x.fillText(title, 256, 112);

  x.fillStyle = "rgba(255,236,200,.42)";
  x.font = "500 30px 'IBM Plex Mono', monospace";
  x.fillText(sub, 256, 176);

  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function Pot3D({
  size = 190,
  variant = "solo",
  dim = false,
  className,
}: {
  size?: number;
  variant?: Variant;
  /** Pushed back behind app content: same room, lower presence. */
  dim?: boolean;
  className?: string;
}) {
  const mountRef = useRef<HTMLDivElement>(null);
  const dropCoinRef = useRef<(() => void) | null>(null);
  const [clicks, setClicks] = useState(0);
  const [ringKey, setRingKey] = useState(0);
  const [hovering, setHovering] = useState(false);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const exhibit = variant === "exhibit";

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    } catch (err) {
      console.error("[Pot3D] could not create a WebGL renderer", err);
      return;
    }

    const width = exhibit ? mount.clientWidth || size : size;
    const height = exhibit ? mount.clientHeight || size : size;

    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.6));
    renderer.setSize(width, height, false);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    mount.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.environment = makeEnvTexture();

    const camera = new THREE.PerspectiveCamera(40, width / height, 0.1, 120);

    // The prototype's coordinate frame: floor at 0, plinth top at 1.60, pot centre 3.30.
    const CY = exhibit ? 3.3 : 0;
    const PLINTH = 1.6;
    const BR = 1.42;

    // ---- lights ------------------------------------------------------------
    scene.add(new THREE.AmbientLight(0xb9aee8, 0.55));

    const key = new THREE.DirectionalLight(0xfff0d8, 2.6);
    key.position.set(4, 9, 5);
    scene.add(key);

    const front = new THREE.DirectionalLight(0xffe7bc, 1.5);
    front.position.set(2, 2.5, 8);
    scene.add(front);

    const fillL = new THREE.PointLight(0xffc978, 60, 16, 2);
    fillL.position.set(2.6, CY + 0.6, 3.2);
    scene.add(fillL);

    const rimL = new THREE.DirectionalLight(0x9d8ef5, 0.95);
    rimL.position.set(-6, 4, -5);
    scene.add(rimL);

    const under = new THREE.DirectionalLight(0xffd8a0, 0.9);
    under.position.set(0, -4, 3);
    scene.add(under);

    if (exhibit) {
      const bounce = new THREE.PointLight(0xffcf8a, 46, 12, 2);
      bounce.position.set(0.8, PLINTH + 0.55, 2.0);
      scene.add(bounce);

      const beamLight = new THREE.SpotLight(0xffe6b0, 190, 26, 0.34, 0.55, 1.6);
      beamLight.position.set(0, 15.5, 0);
      beamLight.target.position.set(0, CY, 0);
      scene.add(beamLight, beamLight.target);

      const inner = new THREE.PointLight(0xf3c572, 26, 16, 2);
      inner.position.set(0, PLINTH + 0.5, 0);
      scene.add(inner);
    }

    // ---- materials ---------------------------------------------------------
    const engrave = makeEngraveTexture();
    const goldMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: engrave,
      bumpMap: engrave,
      bumpScale: 0.06,
      metalness: 1,
      roughness: 0.22,
      envMapIntensity: 1.7,
    });
    const goldLite = new THREE.MeshStandardMaterial({
      color: 0xf2c86e,
      metalness: 1,
      roughness: 0.08,
      envMapIntensity: 1.9,
    });
    const darkMat = new THREE.MeshStandardMaterial({ color: 0x14111c, metalness: 0.6, roughness: 0.35 });

    // ---- the piggy bank ----------------------------------------------------
    // It faces +X. Getting this wrong makes every other offset look arbitrary.
    const rig = new THREE.Group();

    const body = new THREE.Mesh(new THREE.SphereGeometry(BR, 64, 48), goldMat);
    body.scale.set(1.18, 0.94, 1.02);
    rig.add(body);

    const snout = new THREE.Mesh(new THREE.CylinderGeometry(0.46, 0.52, 0.42, 40), goldLite);
    snout.rotation.z = Math.PI / 2;
    snout.position.set(BR * 1.13, 0.05, 0);
    rig.add(snout);

    const snoutFace = new THREE.Mesh(new THREE.CircleGeometry(0.46, 40), goldLite);
    snoutFace.rotation.y = Math.PI / 2;
    snoutFace.position.set(BR * 1.13 + 0.212, 0.05, 0);
    rig.add(snoutFace);

    for (const dz of [-0.17, 0.17]) {
      const n = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.05, 16), darkMat);
      n.rotation.z = Math.PI / 2;
      n.position.set(BR * 1.13 + 0.21, 0.05, dz);
      rig.add(n);
    }

    for (const dz of [-0.42, 0.42]) {
      const ear = new THREE.Mesh(new THREE.ConeGeometry(0.3, 0.44, 4), goldLite);
      ear.position.set(0.62, BR * 0.86, dz);
      ear.rotation.set(dz > 0 ? 0.34 : -0.34, Math.PI / 4, -0.26);
      ear.scale.set(1, 1, 0.55);
      rig.add(ear);
    }

    for (const dz of [-0.44, 0.44]) {
      const e = new THREE.Mesh(new THREE.SphereGeometry(0.098, 20, 16), darkMat);
      e.position.set(1.32, 0.42, dz);
      rig.add(e);

      const g = new THREE.Mesh(new THREE.SphereGeometry(0.03, 10, 8), new THREE.MeshBasicMaterial({ color: 0xfff4d8 }));
      g.position.set(1.4, 0.47, dz + (dz > 0 ? 0.03 : -0.03));
      rig.add(g);
    }

    for (const dx of [0.76, -0.62]) {
      for (const dz of [-0.56, 0.56]) {
        const l = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.28, 0.62, 24), goldMat);
        l.position.set(dx, -BR * 0.8, dz);
        rig.add(l);

        const hoof = new THREE.Mesh(new THREE.CylinderGeometry(0.29, 0.26, 0.1, 24), goldLite);
        hoof.position.set(dx, -BR * 0.8 - 0.3, dz);
        rig.add(hoof);
      }
    }

    const tail = new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.045, 10, 40, 4.6), goldLite);
    tail.position.set(-BR * 1.18, 0.34, 0);
    tail.rotation.set(0, Math.PI / 2, 0.5);
    rig.add(tail);

    // The coin slot runs along Z, across the pig's back.
    const slotRim = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.05, 1.02), goldLite);
    slotRim.position.set(-0.06, BR * 0.9, 0);
    rig.add(slotRim);

    const slot = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.06, 0.86), darkMat);
    slot.position.set(-0.06, BR * 0.925, 0);
    rig.add(slot);

    const slotGlow = new THREE.Mesh(
      new THREE.PlaneGeometry(0.34, 1.06),
      new THREE.MeshBasicMaterial({
        color: 0xffd98a,
        transparent: true,
        opacity: 0.35,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    slotGlow.rotation.x = -Math.PI / 2;
    slotGlow.position.set(-0.06, BR * 0.96, 0);
    rig.add(slotGlow);

    const seam = new THREE.Mesh(new THREE.TorusGeometry(BR * 1.005, 0.017, 8, 140), goldLite);
    seam.rotation.y = Math.PI / 2;
    seam.scale.set(0.94, 1.02, 1);
    rig.add(seam);

    // ---- crossed gold chains bound over the bank ---------------------------
    // Four wraps: two climb clockwise, two counter, so they meet in an X on every flank.
    const linkGeo = new THREE.TorusGeometry(0.105, 0.031, 8, 18);
    const chainMat = new THREE.MeshStandardMaterial({
      color: 0xd9a13c,
      metalness: 1,
      roughness: 0.17,
      emissive: 0xe8b23a,
      emissiveIntensity: 0.26,
      envMapIntensity: 2.0,
    });

    const RX = 1.74;
    const RY = 1.34;
    const RZ = 1.5;
    const wraps = [
      { dir: 1, phase: 0, turns: 1.12 },
      { dir: -1, phase: 0, turns: 1.12 },
      { dir: 1, phase: Math.PI, turns: 1.12 },
      { dir: -1, phase: Math.PI, turns: 1.12 },
    ];

    const pathAt = (w: (typeof wraps)[number], u: number) => {
      const y = -1.02 + 2.04 * u;
      const k = Math.max(0.26, Math.sqrt(Math.max(0.02, 1 - (y / RY) * (y / RY))));
      const ang = w.phase + w.dir * (u - 0.5) * 6.283 * w.turns;
      return new THREE.Vector3(Math.cos(ang) * RX * k, y, Math.sin(ang) * RZ * k);
    };

    const Zaxis = new THREE.Vector3(0, 0, 1);
    const linkMats: THREE.Matrix4[] = [];
    const d2 = new THREE.Object3D();

    for (const w of wraps) {
      let len = 0;
      const prev = pathAt(w, 0);
      for (let i = 1; i <= 160; i++) {
        const p = pathAt(w, i / 160);
        len += p.distanceTo(prev);
        prev.copy(p);
      }
      const n = Math.max(28, Math.round(len / 0.118));
      for (let i = 0; i <= n; i++) {
        const u = i / n;
        const p = pathAt(w, u);
        const tan = pathAt(w, Math.min(1, u + 0.004)).sub(p).normalize();
        const rad = new THREE.Vector3(p.x, 0, p.z).normalize();
        const axis = i % 2 === 0 ? rad : new THREE.Vector3().crossVectors(tan, rad).normalize();
        d2.position.copy(p);
        d2.quaternion.setFromUnitVectors(Zaxis, axis);
        d2.scale.setScalar(1);
        d2.updateMatrix();
        linkMats.push(d2.matrix.clone());
      }
    }

    const chain = new THREE.InstancedMesh(linkGeo, chainMat, linkMats.length);
    chain.frustumCulled = false;
    linkMats.forEach((m, i) => chain.setMatrixAt(i, m));
    chain.instanceMatrix.needsUpdate = true;
    rig.add(chain);

    // Ciphertext running through the links.
    const beadMat = new THREE.MeshBasicMaterial({
      color: 0xffe2a8,
      transparent: true,
      opacity: 0.9,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const beads: { m: THREE.Mesh; t: number }[] = [];
    for (let i = 0; i < 5; i++) {
      const bd = new THREE.Mesh(new THREE.SphereGeometry(0.062, 10, 8), beadMat);
      rig.add(bd);
      beads.push({ m: bd, t: i / 5 });
    }

    // Sealed tag hanging off the middle chain. The green is "sealed", not "gold".
    const tag = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.3, 0.045), goldLite);
    tag.position.set(RX * 0.99, -0.34, 0.14);
    tag.rotation.set(0.18, -0.12, -0.1);
    const tagFace = new THREE.Mesh(
      new THREE.PlaneGeometry(0.3, 0.16),
      new THREE.MeshBasicMaterial({
        color: 0x12b981,
        transparent: true,
        opacity: 0.5,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    tagFace.position.set(0, 0, 0.026);
    tag.add(tagFace);
    const tagLoop = new THREE.Mesh(new THREE.TorusGeometry(0.075, 0.024, 6, 14), goldLite);
    tagLoop.position.set(0, 0.2, 0);
    tag.add(tagLoop);
    rig.add(tag);

    // Padlock where the wraps cross at the front.
    const lockBody = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.42, 0.17), goldLite);
    lockBody.position.set(RX * 1.03, -0.03, 0);
    lockBody.rotation.y = Math.PI / 2;
    const shackle = new THREE.Mesh(new THREE.TorusGeometry(0.145, 0.04, 8, 24, Math.PI), goldMat);
    shackle.position.set(0, 0.21, 0);
    lockBody.add(shackle);
    const keyhole = new THREE.Mesh(
      new THREE.CircleGeometry(0.062, 18),
      new THREE.MeshBasicMaterial({
        color: 0x12b981,
        transparent: true,
        opacity: 0.85,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    keyhole.position.set(0, -0.01, 0.09);
    lockBody.add(keyhole);
    rig.add(lockBody);

    // Crest plate riveted to the flank.
    const crest = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.05, 6), goldLite);
    crest.position.set(-0.1, 0.3, RZ * 0.99);
    crest.rotation.set(Math.PI / 2, 0, 0.26);
    rig.add(crest);

    const rigRoot = new THREE.Group();
    rigRoot.position.y = CY;
    rigRoot.add(rig);
    scene.add(rigRoot);

    // Nested additive shells — a soft halo without a post-processing pass.
    const glowShells: THREE.Mesh[] = [];
    for (const [rad, op] of [
      [2.0, 0.075],
      [2.7, 0.032],
      [3.4, 0.012],
    ] as const) {
      const g = new THREE.Mesh(
        new THREE.SphereGeometry(rad, 32, 24),
        new THREE.MeshBasicMaterial({
          color: 0xf3c572,
          transparent: true,
          opacity: op,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          side: THREE.BackSide,
        }),
      );
      glowShells.push(g);
      rigRoot.add(g);
    }

    // ---- coins in the pot --------------------------------------------------
    const MAX_COINS = 40;
    const coinGeo = new THREE.CylinderGeometry(0.2, 0.2, 0.045, 22);
    const coins = new THREE.InstancedMesh(coinGeo, goldLite, MAX_COINS);
    coins.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    coins.count = 0;
    coins.position.y = CY;
    scene.add(coins);

    // A sealed-green face inside a gold rim — the same green as the seal tag and the
    // keyhole, so a coin going in reads as ciphertext rather than money. Sits just
    // proud of both faces of the coin, leaving the gold showing as an edge.
    const pips = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(0.145, 0.145, 0.052, 24),
      // Lit rather than flat: it needs to darken at an angle the way the reference
      // does, and an unlit fill reads as a sticker.
      new THREE.MeshStandardMaterial({
        color: 0x12b981,
        metalness: 0.4,
        roughness: 0.42,
        emissive: 0x0a5f43,
        emissiveIntensity: 0.28,
      }),
      MAX_COINS,
    );
    pips.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    pips.count = 0;
    pips.position.y = CY;
    scene.add(pips);

    type Coin = { x: number; y: number; z: number; vy: number; rest: number };
    const live: Coin[] = [];
    const dummy = new THREE.Object3D();
    let pulse = 0;

    // A coin goes in the way a coin goes into a bank: down the slot on the pot's
    // back. These match the slot mesh, so the two never drift apart.
    const SLOT_X = -0.06;
    const SLOT_Y = BR * 0.88;

    dropCoinRef.current = () => {
      if (live.length >= MAX_COINS) live.shift();
      // Straight down the pot's axis, so the coin meets the slot however far the
      // rig has spun. The jitter is the slot's own footprint: narrow across, long
      // down its length.
      live.push({
        x: SLOT_X + (Math.random() - 0.5) * 0.1,
        y: 2.9,
        z: (Math.random() - 0.5) * 0.5,
        vy: 0,
        rest: SLOT_Y,
      });
    };

    // The pool never stops taking deposits, so the pot never sits still — a coin
    // lands on its own every couple of seconds and the body pumps with it. Only on
    // the landing's full scene: behind the app tabs it would pull the eye off the
    // panels, and the small inline pot has no room for it.
    let ambient = 0;
    const stillPreferred = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (exhibit && !dim && !stillPreferred) {
      ambient = window.setInterval(() => dropCoinRef.current?.(), 1300);
    }

    // ---- the exhibit -------------------------------------------------------
    let orbitRing: THREE.Group | undefined;
    let veilTex: THREE.Texture | undefined;

    if (exhibit) {
      // Visible light shaft.
      const cone = new THREE.Mesh(
        new THREE.CylinderGeometry(0.5, 3.4, 12, 40, 1, true),
        new THREE.MeshBasicMaterial({
          color: 0xffe0a8,
          transparent: true,
          opacity: 0.028,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          side: THREE.DoubleSide,
        }),
      );
      cone.position.y = CY + 6.6;
      scene.add(cone);

      // Plinth and column.
      const plinth = new THREE.Mesh(new THREE.CylinderGeometry(3.0, 3.24, 0.3, 72), goldMat);
      plinth.position.y = PLINTH - 0.15;

      const plinthLip = new THREE.Mesh(new THREE.TorusGeometry(3.0, 0.05, 10, 96), goldLite);
      plinthLip.rotation.x = Math.PI / 2;
      plinthLip.position.y = PLINTH;

      const column = new THREE.Mesh(
        new THREE.CylinderGeometry(0.9, 1.5, 1.5, 48),
        new THREE.MeshStandardMaterial({ color: 0x2a2436, metalness: 0.75, roughness: 0.42 }),
      );
      column.position.y = PLINTH / 2 - 0.15;
      scene.add(plinth, plinthLip, column);

      // The takings, heaped around the foot of the bank so it stands in its own
      // money rather than on bare stone. Denser at the base and thinning outward,
      // with a second course on top so the ring reads as a pile, not a pattern.
      const BED = 130;
      const bed = new THREE.InstancedMesh(
        new THREE.CylinderGeometry(0.2, 0.2, 0.05, 20),
        new THREE.MeshStandardMaterial({
          color: 0xf7cb5e,
          metalness: 1,
          roughness: 0.18,
          emissive: 0xc27f12,
          emissiveIntensity: 0.3,
        }),
        BED,
      );
      for (let i = 0; i < BED; i++) {
        const a = Math.random() * 6.283;
        // Biased inward: squaring a unit random crowds the ring against the pot.
        const rr = 1.5 + Math.pow(Math.random(), 2) * 1.35;
        const stacked = Math.random() < 0.3;
        dummy.position.set(
          Math.cos(a) * rr,
          PLINTH + (stacked ? 0.08 : 0.028) + Math.random() * 0.03,
          Math.sin(a) * rr,
        );
        // Mostly lying flat; a few tipped up against the heap.
        const tilt = Math.random() < 0.16 ? 0.5 + Math.random() * 0.7 : Math.random() * 0.22;
        dummy.rotation.set(tilt, Math.random() * 6.283, Math.random() * 0.2);
        dummy.scale.setScalar(0.72 + Math.random() * 0.4);
        dummy.updateMatrix();
        bed.setMatrixAt(i, dummy.matrix);
      }
      dummy.scale.setScalar(1);
      bed.instanceMatrix.needsUpdate = true;
      scene.add(bed);

      // ---- plinth detailing ------------------------------------------------
      const studs = new THREE.InstancedMesh(new THREE.SphereGeometry(0.058, 12, 10), goldLite, 44);
      for (let i = 0; i < 44; i++) {
        const a = (i / 44) * 6.283;
        dummy.position.set(Math.cos(a) * 3.13, PLINTH - 0.13, Math.sin(a) * 3.13);
        dummy.rotation.set(0, 0, 0);
        dummy.scale.setScalar(1);
        dummy.updateMatrix();
        studs.setMatrixAt(i, dummy.matrix);
      }
      studs.instanceMatrix.needsUpdate = true;
      scene.add(studs);

      const inlay = new THREE.Mesh(
        new THREE.TorusGeometry(2.94, 0.013, 8, 140),
        new THREE.MeshBasicMaterial({
          color: 0x12b981,
          transparent: true,
          opacity: 0.45,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
      );
      inlay.rotation.x = Math.PI / 2;
      inlay.position.y = PLINTH + 0.006;
      scene.add(inlay);

      // Ingot stacks around the plinth edge.
      const ingotGeo = new THREE.BoxGeometry(0.46, 0.13, 0.25);
      for (const [a, n] of [
        [0.55, 3],
        [2.45, 2],
        [4.05, 3],
        [5.35, 1],
      ] as const) {
        for (let i = 0; i < n; i++) {
          const bar = new THREE.Mesh(ingotGeo, goldLite);
          bar.position.set(Math.cos(a) * 2.94, PLINTH + 0.075 + i * 0.135, Math.sin(a) * 2.94);
          bar.rotation.y = -a + 0.4 + i * 0.12;
          scene.add(bar);
        }
      }

      // ---- the room --------------------------------------------------------
      const capsMat = new THREE.MeshStandardMaterial({ color: 0xb98d3c, metalness: 0.95, roughness: 0.35 });

      const marbleTex = makeMarbleTexture();
      const marble = new THREE.Mesh(
        new THREE.CircleGeometry(15.5, 96),
        new THREE.MeshStandardMaterial({
          map: marbleTex,
          emissiveMap: marbleTex,
          emissive: 0x8a6a2a,
          emissiveIntensity: 0.34,
          metalness: 0.62,
          roughness: 0.26,
        }),
      );
      marble.rotation.x = -Math.PI / 2;
      marble.position.y = -0.012;
      scene.add(marble);

      const outerFloor = new THREE.Mesh(
        new THREE.RingGeometry(15.4, 40, 72),
        new THREE.MeshStandardMaterial({ color: 0x0a1015, metalness: 0.6, roughness: 0.4 }),
      );
      outerFloor.rotation.x = -Math.PI / 2;
      outerFloor.position.y = -0.02;
      scene.add(outerFloor);

      const floorWash = new THREE.PointLight(0xffd9a0, 55, 26, 2.2);
      floorWash.position.set(0, 0.85, 0);
      scene.add(floorWash);

      // The drum. Lit by its own emissive map so it glows without needing a light on it.
      const wallTex = makeWallTexture();
      const walls = new THREE.Mesh(
        new THREE.CylinderGeometry(25, 25, 26, 96, 1, true),
        new THREE.MeshStandardMaterial({
          map: wallTex,
          emissiveMap: wallTex,
          emissive: 0xffffff,
          emissiveIntensity: 0.42,
          metalness: 0.35,
          roughness: 0.8,
          side: THREE.BackSide,
        }),
      );
      walls.position.y = 11.4;
      scene.add(walls);

      veilTex = makeVeilTexture();
      const veil = new THREE.Mesh(
        new THREE.CylinderGeometry(23.6, 23.6, 24, 64, 1, true),
        new THREE.MeshBasicMaterial({
          map: veilTex,
          transparent: true,
          opacity: 0.55,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          side: THREE.BackSide,
        }),
      );
      veil.position.y = 10.6;
      scene.add(veil);

      const cornice = new THREE.Mesh(
        new THREE.TorusGeometry(24.9, 0.34, 10, 120),
        new THREE.MeshStandardMaterial({ color: 0xb98d3c, metalness: 0.95, roughness: 0.32 }),
      );
      cornice.rotation.x = Math.PI / 2;
      cornice.position.y = 18.4;
      scene.add(cornice);

      const skirt = new THREE.Mesh(
        new THREE.CylinderGeometry(25.4, 25.9, 0.7, 72, 1, true),
        new THREE.MeshStandardMaterial({ color: 0x1b1a18, metalness: 0.5, roughness: 0.6, side: THREE.DoubleSide }),
      );
      skirt.position.y = 0.05;
      scene.add(skirt);

      const skirtLip = new THREE.Mesh(new THREE.TorusGeometry(25.4, 0.1, 8, 96), capsMat);
      skirtLip.rotation.x = Math.PI / 2;
      skirtLip.position.y = 0.4;
      scene.add(skirtLip);

      // Inlaid rails.
      for (const [rr, tk] of [
        [6.3, 0.045],
        [9.9, 0.05],
        [11.4, 0.028],
      ] as const) {
        const rail = new THREE.Mesh(new THREE.TorusGeometry(rr, tk, 8, 140), capsMat);
        rail.rotation.x = Math.PI / 2;
        rail.position.y = 0.03;
        scene.add(rail);
      }

      // Mosaic ring, alternating size and angle so it reads as laid tile.
      const tiles = new THREE.InstancedMesh(new THREE.BoxGeometry(0.3, 0.05, 0.3), capsMat, 128);
      for (let i = 0; i < 128; i++) {
        const a = (i / 128) * 6.283;
        dummy.rotation.set(0, -a + (i % 2 ? 0.78 : 0), 0);
        dummy.scale.setScalar(i % 2 ? 0.7 : 1);
        dummy.position.set(Math.cos(a) * 8.1, 0.035, Math.sin(a) * 8.1);
        dummy.updateMatrix();
        tiles.setMatrixAt(i, dummy.matrix);
      }
      dummy.scale.setScalar(1);
      tiles.instanceMatrix.needsUpdate = true;
      scene.add(tiles);

      // Light arcs washing the floor.
      const arcMat = new THREE.MeshBasicMaterial({
        color: 0xe8b23a,
        transparent: true,
        opacity: 0.22,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      for (let i = 0; i < 6; i++) {
        const arc = new THREE.Mesh(new THREE.RingGeometry(12.3, 12.55, 40, 1, (i / 6) * 6.283, 0.66), arcMat);
        arc.rotation.x = -Math.PI / 2;
        arc.position.y = 0.04;
        scene.add(arc);
      }

      // Coins spilled on the marble.
      const spill = new THREE.InstancedMesh(
        new THREE.CylinderGeometry(0.2, 0.2, 0.055, 20),
        new THREE.MeshStandardMaterial({
          color: 0xf7cb5e,
          metalness: 1,
          roughness: 0.16,
          emissive: 0xc27f12,
          emissiveIntensity: 0.35,
        }),
        54,
      );
      for (let i = 0; i < 54; i++) {
        const a = Math.random() * 6.283;
        const rr = 3.5 + Math.random() * 3.4;
        dummy.rotation.set(Math.random() * 0.25, Math.random() * 6.283, Math.random() * 0.25);
        dummy.scale.setScalar(0.8 + Math.random() * 0.5);
        dummy.position.set(Math.cos(a) * rr, 0.05, Math.sin(a) * rr);
        dummy.updateMatrix();
        spill.setMatrixAt(i, dummy.matrix);
      }
      dummy.scale.setScalar(1);
      spill.instanceMatrix.needsUpdate = true;
      scene.add(spill);

      // Past draws, hung flush on the wall. The history, mounted.
      const DRAWS_3D: [string, string][] = [
        ["DRAW #17", "SETTLED"],
        ["DRAW #16", "SETTLED"],
        ["DRAW #15", "SETTLED"],
        ["DRAW #14", "SETTLED"],
        ["DRAW #13", "SETTLED"],
      ];
      for (let i = 0; i < DRAWS_3D.length; i++) {
        const a = (i / DRAWS_3D.length) * 6.283 + 0.55;
        const tex = makePlacardTexture(DRAWS_3D[i][0], DRAWS_3D[i][1]);
        const placard = new THREE.Mesh(
          new THREE.PlaneGeometry(3.1, 1.55),
          new THREE.MeshStandardMaterial({
            map: tex,
            emissiveMap: tex,
            emissive: 0xffffff,
            emissiveIntensity: 0.55,
            metalness: 0.3,
            roughness: 0.7,
          }),
        );
        placard.position.set(Math.cos(a) * 24.3, 6.4, Math.sin(a) * 24.3);
        placard.lookAt(0, 6.4, 0);
        scene.add(placard);
      }

      // Stanchions with a swagged chain rope.
      const POSTS = 6;
      const PR = 4.4;
      const ROPE_Y = PLINTH + 1.42;
      const linkGeo = new THREE.TorusGeometry(0.085, 0.026, 8, 14);
      const chainMat = goldLite;

      for (let i = 0; i < POSTS; i++) {
        const a = (i / POSTS) * 6.283 + 0.26;
        const px = Math.cos(a) * PR;
        const pz = Math.sin(a) * PR;

        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.1, 1.46, 18), goldMat);
        post.position.set(px, PLINTH + 0.73, pz);

        const cap = new THREE.Mesh(new THREE.SphereGeometry(0.125, 16, 12), goldLite);
        cap.position.set(px, PLINTH + 1.52, pz);

        const base = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.3, 0.085, 20), goldLite);
        base.position.set(px, PLINTH + 0.045, pz);

        scene.add(post, cap, base);
      }

      // The rope droops between posts, links alternating axis so it reads as chain.
      const Z = new THREE.Vector3(0, 0, 1);
      const swag: THREE.Matrix4[] = [];
      const d3 = new THREE.Object3D();

      for (let i = 0; i < POSTS; i++) {
        const a0 = (i / POSTS) * 6.283 + 0.26;
        const a1 = ((i + 1) / POSTS) * 6.283 + 0.26;
        const p0 = new THREE.Vector3(Math.cos(a0) * PR, ROPE_Y, Math.sin(a0) * PR);
        const p1 = new THREE.Vector3(Math.cos(a1) * PR, ROPE_Y, Math.sin(a1) * PR);
        const at = (t: number) => {
          const p = p0.clone().lerp(p1, t);
          p.y -= Math.sin(t * Math.PI) * 0.46;
          return p;
        };

        const N = 26;
        for (let j = 0; j <= N; j++) {
          const t = j / N;
          const p = at(t);
          const tan = at(Math.min(1, t + 0.02)).sub(p).normalize();
          const rad = new THREE.Vector3(p.x, 0, p.z).normalize();
          const axis = j % 2 === 0 ? rad : new THREE.Vector3().crossVectors(tan, rad).normalize();
          d3.position.copy(p);
          d3.quaternion.setFromUnitVectors(Z, axis);
          d3.scale.setScalar(0.92);
          d3.updateMatrix();
          swag.push(d3.matrix.clone());
        }
      }

      const rope = new THREE.InstancedMesh(linkGeo, chainMat, swag.length);
      rope.frustumCulled = false;
      swag.forEach((m, i) => rope.setMatrixAt(i, m));
      rope.instanceMatrix.needsUpdate = true;
      scene.add(rope);

      // Sealed ciphertext plates, orbiting.
      orbitRing = new THREE.Group();
      orbitRing.position.y = CY + 0.35;
      scene.add(orbitRing);

      const plateMat = new THREE.MeshStandardMaterial({
        color: 0x14202a,
        metalness: 0.8,
        roughness: 0.3,
        emissive: 0x0d6b4c,
        emissiveIntensity: 0.16,
      });

      for (let i = 0; i < 7; i++) {
        const a = (i / 7) * 6.283;
        const pl = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.22, 0.02), plateMat);
        pl.position.set(Math.cos(a) * 5.05, Math.sin(i * 1.7) * 0.85, Math.sin(a) * 5.05);
        pl.rotation.set(0.12, -a + Math.PI / 2, 0.14);
        orbitRing.add(pl);

        const clip = new THREE.Mesh(new THREE.TorusGeometry(0.055, 0.016, 6, 12), goldLite);
        clip.position.set(0, 0.14, 0);
        clip.scale.setScalar(0.7);
        pl.add(clip);
      }
    }

    // ---- orbit -------------------------------------------------------------
    const orbit = exhibit ? { az: 0.85, el: 0.22, r: 13.4 } : { az: 0.85, el: 0.13, r: 6.2 };
    const target = { ...orbit };
    const REST_EL = orbit.el;
    const MIN_R = exhibit ? 8 : 4.6;
    const MAX_R = exhibit ? 20 : 9;
    const LOOK_Y = exhibit ? CY - 0.35 : 0.1;

    let dragging = false;
    let travelled = 0;
    let lastX = 0;
    let lastY = 0;
    let hovered = false;

    const el = renderer.domElement;

    const onDown = (e: PointerEvent) => {
      dragging = true;
      travelled = 0;
      lastX = e.clientX;
      lastY = e.clientY;
      el.setPointerCapture(e.pointerId);
    };

    const onMove = (e: PointerEvent) => {
      if (!dragging) return;
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      travelled += Math.abs(dx) + Math.abs(dy);
      lastX = e.clientX;
      lastY = e.clientY;
      target.az -= dx * 0.008;
      target.el = Math.min(0.72, Math.max(0.02, target.el + dy * 0.005));
    };

    const onUp = (e: PointerEvent) => {
      if (!dragging) return;
      dragging = false;
      el.releasePointerCapture(e.pointerId);
      if (travelled < 6) {
        dropCoinRef.current?.();
        setClicks((c) => c + 1);
        setRingKey((k) => k + 1);
      }
    };

    const onWheel = (e: WheelEvent) => {
      if (!exhibit) return;
      e.preventDefault();
      target.r = Math.min(MAX_R, Math.max(MIN_R, target.r + e.deltaY * 0.01));
    };

    const onEnter = () => {
      hovered = true;
      setHovering(true);
    };
    const onLeave = () => {
      hovered = false;
      setHovering(false);
    };

    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointerenter", onEnter);
    el.addEventListener("pointerleave", onLeave);
    el.addEventListener("wheel", onWheel, { passive: false });

    // "Drop a deposit" on the landing throws three coins in, 130ms apart.
    const onDropRequest = () => {
      for (let i = 0; i < 3; i++) setTimeout(() => dropCoinRef.current?.(), i * 130);
    };
    window.addEventListener("hushpot:drop", onDropRequest);

    const onResize = () => {
      if (!exhibit) return;
      const w = mount.clientWidth || size;
      const h = mount.clientHeight || size;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    window.addEventListener("resize", onResize);

    // ---- loop --------------------------------------------------------------
    let raf = 0;
    let t = 0;

    const tick = () => {
      raf = requestAnimationFrame(tick);
      t += 1 / 60;

      // Idle turn, but hold still while someone is looking at it.
      if (!dragging && !hovered) target.az += 0.0013;
      if (!dragging) target.el += (REST_EL - target.el) * 0.045;

      orbit.az += (target.az - orbit.az) * 0.08;
      orbit.el += (target.el - orbit.el) * 0.08;
      orbit.r += (target.r - orbit.r) * 0.08;

      camera.position.set(
        Math.sin(orbit.az) * Math.cos(orbit.el) * orbit.r,
        LOOK_Y + Math.sin(orbit.el) * orbit.r,
        Math.cos(orbit.az) * Math.cos(orbit.el) * orbit.r,
      );
      camera.lookAt(0, LOOK_Y, 0);

      // Fall, then go in. Reaching the slot removes the coin and knocks the body,
      // which is the whole gesture: the money disappears into a pot nobody opens.
      for (let i = live.length - 1; i >= 0; i--) {
        const c = live[i];
        c.vy -= 0.012;
        c.y += c.vy;
        if (c.y <= c.rest) {
          live.splice(i, 1);
          pulse = 1;
        }
      }
      coins.count = live.length;
      pips.count = live.length;
      // The slot turns with the rig, so the coins are held in rig-local space and
      // swung into world space here. Rotated edge-on and squared to the slot's
      // length — a coin lying flat would not fit through it.
      const ry = rig.rotation.y;
      const cosY = Math.cos(ry);
      const sinY = Math.sin(ry);
      live.forEach((c, i) => {
        dummy.position.set(c.x * cosY + c.z * sinY, c.y, -c.x * sinY + c.z * cosY);
        dummy.rotation.set(0, ry, Math.PI / 2);
        dummy.updateMatrix();
        coins.setMatrixAt(i, dummy.matrix);
        pips.setMatrixAt(i, dummy.matrix);
      });
      coins.instanceMatrix.needsUpdate = true;
      pips.instanceMatrix.needsUpdate = true;

      // Ciphertext beads travel the chain path, so the binding always looks live.
      for (const b of beads) {
        b.t = (b.t + 0.0016) % 1;
        b.m.position.copy(pathAt(wraps[0], b.t));
      }

      if (orbitRing) orbitRing.rotation.y += 0.0016;
      // The haze drifts around the drum, so the room never quite sits still.
      if (veilTex) veilTex.offset.x = (t * 0.006) % 1;

      // The pot turns on its own, independently of the camera.
      rig.rotation.y += 0.0024;
      rig.position.y = Math.sin(t * 0.6) * 0.03;

      // Squash and stretch when a coin lands, easing back out.
      if (pulse > 0) {
        pulse = Math.max(0, pulse - 0.04);
        const squash = Math.sin(pulse * Math.PI) * 0.055;
        rig.scale.set(1 + squash, 1 - squash, 1 + squash);
        if (glowShells) glowShells.forEach((g) => g.scale.setScalar(1 + squash * 1.6));
      }

      renderer.render(scene, camera);
    };
    tick();

    return () => {
      cancelAnimationFrame(raf);
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointerenter", onEnter);
      el.removeEventListener("pointerleave", onLeave);
      el.removeEventListener("wheel", onWheel);
      window.removeEventListener("hushpot:drop", onDropRequest);
      if (ambient) window.clearInterval(ambient);
      window.removeEventListener("resize", onResize);
      renderer.dispose();
      engrave.dispose();
      scene.traverse((o) => {
        if (o instanceof THREE.Mesh) o.geometry.dispose();
      });
      if (el.parentNode) el.parentNode.removeChild(el);
    };
  }, [size, variant, dim]);

  const quip = QUIPS[clicks % QUIPS.length];
  const exhibit = variant === "exhibit";

  return (
    <div
      className={`${exhibit ? styles.exhibitWrap : styles.wrap} ${dim ? styles.dimmed : ""} ${className ?? ""}`}
    >
      {!exhibit && <div className={styles.glow} aria-hidden="true" />}

      <div
        ref={mountRef}
        className={exhibit ? styles.exhibitCanvas : styles.canvas}
        style={exhibit ? undefined : { width: size, height: size }}
        role="img"
        aria-label="A gold pot on a plinth, behind a rope. Drag to turn it, click to drop a coin in."
      />

      {ringKey > 0 && !exhibit && (
        <span key={ringKey} className={styles.ring} style={{ width: size, height: size }} aria-hidden="true" />
      )}

      {!exhibit && <div className={styles.shadow} aria-hidden="true" />}

      <div className={exhibit ? styles.exhibitHint : styles.hint}>
        {hovering ? "DRAG TO TURN · CLICK TO DROP · SCROLL TO ZOOM" : "IT TURNS ON ITS OWN · HOVER TO TAKE THE WHEEL"}
      </div>

      {quip && <div className={exhibit ? styles.exhibitQuip : styles.quip}>{quip}</div>}
    </div>
  );
}
