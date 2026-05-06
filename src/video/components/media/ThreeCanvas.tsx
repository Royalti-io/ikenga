/**
 * ThreeCanvas — stub wrapper for @remotion/three 3D rendering.
 *
 * Provides a ready-to-use 3D canvas component for Remotion compositions.
 * Currently a minimal demo — expand when specific 3D use cases arise.
 *
 * @example
 * <ThreeCanvasDemo />
 */

import React, { useRef } from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";
import { ThreeCanvas } from "@remotion/three";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";

// ── Rotating Cube (demo scene) ───────────────────────────────────────────

const RotatingCube: React.FC<{ color?: string }> = ({ color = "#006666" }) => {
  const meshRef = useRef<THREE.Mesh>(null);
  const frame = useCurrentFrame();

  useFrame(() => {
    if (meshRef.current) {
      meshRef.current.rotation.x = frame * 0.02;
      meshRef.current.rotation.y = frame * 0.03;
    }
  });

  return (
    <mesh ref={meshRef}>
      <boxGeometry args={[2, 2, 2]} />
      <meshStandardMaterial color={color} />
    </mesh>
  );
};

// ── Public Component ─────────────────────────────────────────────────────

export interface ThreeCanvasDemoProps {
  /** Cube color. Default: BRAND.primary (#006666) */
  color?: string;
  /** Background color. Default: transparent */
  backgroundColor?: string;
}

export const ThreeCanvasDemo: React.FC<ThreeCanvasDemoProps> = ({
  color = "#006666",
  backgroundColor,
}) => {
  const { width, height } = useVideoConfig();
  return (
    <ThreeCanvas
      width={width}
      height={height}
      orthographic={false}
      style={{ width: "100%", height: "100%" }}
      camera={{ position: [4, 3, 4], fov: 50 }}
      gl={{ alpha: !backgroundColor }}
    >
      {backgroundColor && <color attach="background" args={[backgroundColor]} />}
      <ambientLight intensity={0.5} />
      <directionalLight position={[5, 5, 5]} intensity={1} />
      <RotatingCube color={color} />
    </ThreeCanvas>
  );
};
