"use client";

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";

import styles from "./Pot3D.module.css";

/**
 * The pot — a stylised gold piggy bank, built from primitives.
 *
 * Drag to turn it, click to drop a coin in. Each click also advances a quip, because a
 * money box that can't be read from the outside deserves a bit of personality.
 *
 * Deliberately its own renderer scoped to this component rather than one shared canvas
 * docked across screens: React remounts make the shared-canvas trick fragile, and one
 * small scene is cheap.
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

export function Pot3D({ size = 190, className }: { size?: number; className?: string }) {
  const mountRef = useRef<HTMLDivElement>(null);
  const dropCoinRef = useRef<(() => void) | null>(null);
  const [clicks, setClicks] = useState(0);
  const [ringKey, setRingKey] = useState(0);
  const [hovering, setHovering] = useState(false);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) {
      console.error("[Pot3D] mount ref was null");
      return;
    }

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    } catch (err) {
      console.error("[Pot3D] could not create a WebGL renderer", err);
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.6));
    renderer.setSize(size, size, false);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    mount.appendChild(renderer.domElement);

    const scene = new THREE.Scene();

    // Metal at metalness 1 renders black without something to reflect.
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

    const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);

    const gold = new THREE.MeshStandardMaterial({
      color: 0xffc633,
      metalness: 1,
      roughness: 0.15,
      envMapIntensity: 1.6,
      emissive: 0x2a1a00,
    });
    const darkGold = new THREE.MeshStandardMaterial({
      color: 0xb8860b,
      metalness: 1,
      roughness: 0.3,
      envMapIntensity: 1.2,
    });
    const nearBlack = new THREE.MeshStandardMaterial({ color: 0x11100c, metalness: 0.6, roughness: 0.5 });
    const glint = new THREE.MeshBasicMaterial({ color: 0xffffff });

    // ---- the pot ----------------------------------------------------------
    const rig = new THREE.Group();
    scene.add(rig);

    const body = new THREE.Mesh(new THREE.SphereGeometry(1.42, 48, 36), gold);
    body.scale.set(1.16, 0.98, 1);
    rig.add(body);

    const snout = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.46, 0.34, 28), gold);
    snout.rotation.x = Math.PI / 2;
    snout.position.set(0, -0.06, 1.42);
    rig.add(snout);

    const face = new THREE.Mesh(new THREE.CircleGeometry(0.42, 28), darkGold);
    face.position.set(0, -0.06, 1.6);
    rig.add(face);

    for (const x of [-0.15, 0.15]) {
      const nostril = new THREE.Mesh(new THREE.CircleGeometry(0.075, 16), nearBlack);
      nostril.position.set(x, -0.06, 1.605);
      rig.add(nostril);
    }

    for (const x of [-0.62, 0.62]) {
      const ear = new THREE.Mesh(new THREE.ConeGeometry(0.3, 0.5, 20), gold);
      ear.position.set(x, 1.08, 0.6);
      ear.rotation.set(-0.35, 0, x > 0 ? -0.3 : 0.3);
      rig.add(ear);
    }

    for (const x of [-0.5, 0.5]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.13, 20, 16), nearBlack);
      eye.position.set(x, 0.34, 1.24);
      rig.add(eye);

      const spark = new THREE.Mesh(new THREE.SphereGeometry(0.045, 12, 10), glint);
      spark.position.set(x + 0.05, 0.4, 1.33);
      rig.add(spark);
    }

    for (const [x, z] of [
      [-0.66, 0.62],
      [0.66, 0.62],
      [-0.66, -0.62],
      [0.66, -0.62],
    ]) {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.22, 0.62, 20), gold);
      leg.position.set(x, -1.16, z);
      rig.add(leg);

      const hoof = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.25, 0.1, 20), darkGold);
      hoof.position.set(x, -1.46, z);
      rig.add(hoof);
    }

    const tail = new THREE.Mesh(new THREE.TorusGeometry(0.22, 0.055, 12, 30, Math.PI * 1.6), gold);
    tail.position.set(0, 0.34, -1.42);
    tail.rotation.set(0, Math.PI / 2, 0.6);
    rig.add(tail);

    // Coin slot — where the money goes in and the privacy begins.
    const slot = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.045, 0.16), nearBlack);
    slot.position.set(0, 1.34, 0.06);
    rig.add(slot);

    const slotRim = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.03, 0.26), darkGold);
    slotRim.position.set(0, 1.32, 0.06);
    rig.add(slotRim);

    const slotGlow = new THREE.Mesh(
      new THREE.PlaneGeometry(0.66, 0.2),
      new THREE.MeshBasicMaterial({ color: 0xffd208, transparent: true, opacity: 0.28, blending: THREE.AdditiveBlending }),
    );
    slotGlow.rotation.x = -Math.PI / 2;
    slotGlow.position.set(0, 1.355, 0.06);
    rig.add(slotGlow);

    const seam = new THREE.Mesh(new THREE.TorusGeometry(1.44, 0.018, 10, 80), darkGold);
    seam.rotation.x = Math.PI / 2;
    seam.scale.set(1.16, 1, 1);
    rig.add(seam);

    // ---- coins ------------------------------------------------------------
    const MAX_COINS = 40;
    const coinGeo = new THREE.CylinderGeometry(0.2, 0.2, 0.045, 22);
    const coins = new THREE.InstancedMesh(coinGeo, gold, MAX_COINS);
    coins.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    coins.count = 0;
    scene.add(coins);

    type Coin = { x: number; y: number; z: number; vy: number; spin: number; rest: number };
    const live: Coin[] = [];
    const dummy = new THREE.Object3D();

    dropCoinRef.current = () => {
      if (live.length >= MAX_COINS) live.shift();
      live.push({
        x: (Math.random() - 0.5) * 0.5,
        y: 2.6,
        z: (Math.random() - 0.5) * 0.5,
        vy: 0,
        spin: Math.random() * Math.PI,
        rest: -1.42 + Math.random() * 0.12,
      });
    };

    // ---- lights -----------------------------------------------------------
    scene.add(new THREE.AmbientLight(0xffffff, 0.35));
    const key = new THREE.DirectionalLight(0xfff0c0, 2.4);
    key.position.set(3, 5, 4);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0xffd208, 1.5);
    rim.position.set(-4, 2, -3);
    scene.add(rim);

    // ---- orbit ------------------------------------------------------------
    const orbit = { az: 0.35, el: 0.13, r: 9.9 };
    const target = { ...orbit };
    const REST = { az: 0.35, el: 0.13 };

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
      // A pointer-up that barely moved is a click, not a drag.
      if (travelled < 6) {
        dropCoinRef.current?.();
        setClicks((c) => c + 1);
        setRingKey((k) => k + 1);
      }
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

    // ---- loop -------------------------------------------------------------
    let raf = 0;
    let t = 0;

    const tick = () => {
      raf = requestAnimationFrame(tick);
      t += 1 / 60;

      // Idle turn, but hold still while someone is looking at it.
      if (!dragging && !hovered) target.az += 0.0016;
      if (!dragging) {
        target.az += (REST.az - target.az) * 0.0;
        target.el += (REST.el - target.el) * 0.045;
      }

      orbit.az += (target.az - orbit.az) * 0.08;
      orbit.el += (target.el - orbit.el) * 0.08;
      orbit.r += (target.r - orbit.r) * 0.08;

      camera.position.set(
        Math.sin(orbit.az) * Math.cos(orbit.el) * orbit.r,
        Math.sin(orbit.el) * orbit.r,
        Math.cos(orbit.az) * Math.cos(orbit.el) * orbit.r,
      );
      camera.lookAt(0, 0.55, 0);

      // Coins fall into the pile.
      for (const c of live) {
        if (c.y > c.rest) {
          c.vy -= 0.012;
          c.y = Math.max(c.rest, c.y + c.vy);
          if (c.y === c.rest) c.vy = 0;
        }
        c.spin += 0.04;
      }
      coins.count = live.length;
      live.forEach((c, i) => {
        dummy.position.set(c.x, c.y, c.z);
        dummy.rotation.set(c.y > c.rest ? c.spin : Math.PI / 2, c.spin * 0.4, 0);
        dummy.updateMatrix();
        coins.setMatrixAt(i, dummy.matrix);
      });
      coins.instanceMatrix.needsUpdate = true;

      rig.position.y = Math.sin(t * 0.6) * 0.03;

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
      pmrem.dispose();
      renderer.dispose();
      scene.traverse((o) => {
        if (o instanceof THREE.Mesh) o.geometry.dispose();
      });
      if (el.parentNode) el.parentNode.removeChild(el);
    };
  }, [size]);

  const quip = QUIPS[clicks % QUIPS.length];

  return (
    <div className={`${styles.wrap} ${className ?? ""}`}>
      <div className={styles.glow} aria-hidden="true" />
      <div
        ref={mountRef}
        className={styles.canvas}
        style={{ width: size, height: size }}
        role="img"
        aria-label="A gold pot. Drag to turn it, click to drop a coin in."
      />
      {ringKey > 0 && <span key={ringKey} className={styles.ring} style={{ width: size, height: size }} aria-hidden="true" />}
      <div className={styles.shadow} aria-hidden="true" />
      <div className={styles.hint}>{hovering ? "DRAG TO TURN · CLICK TO DROP" : "CLICK IT · DRAG TO TURN"}</div>
      <div className={styles.quip}>{quip}</div>
    </div>
  );
}
