/**
 * Tests for defineComposition() — registration, idempotency, retrieval.
 *
 * Note: renderCompositions() creates React elements which requires a DOM
 * environment. Since vitest is configured for node environment, we only test
 * the registry state (defineComposition, getRegistry) and not renderCompositions().
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  defineComposition,
  getRegistry,
  _resetRegistryForTests,
} from "./define-composition";

// Mock a minimal React component (no React import needed since we're just testing registry)
const MockComponent = (() => null) as any;

// ── Reset between tests ────────────────────────────────────────────────────

beforeEach(() => {
  _resetRegistryForTests();
});

// ── Registration ───────────────────────────────────────────────────────────

describe("defineComposition — registration", () => {
  it("registers a composition and makes it discoverable via getRegistry()", () => {
    defineComposition({
      id: "MyVideo",
      component: MockComponent,
      fps: 30,
      width: 1080,
      height: 1920,
      durationInFrames: 300,
      defaultProps: {},
    });

    const registry = getRegistry();
    expect(registry).toHaveLength(1);
    expect(registry[0].id).toBe("MyVideo");
  });

  it("stores all provided fields", () => {
    defineComposition({
      id: "FullVideo",
      component: MockComponent,
      fps: 24,
      width: 1920,
      height: 1080,
      durationInFrames: 720,
      defaultProps: { narrationFile: "test.mp3" },
      narrationFile: "test.mp3",
      folder: "Content",
    });

    const [def] = getRegistry();
    expect(def.fps).toBe(24);
    expect(def.width).toBe(1920);
    expect(def.height).toBe(1080);
    expect(def.durationInFrames).toBe(720);
    expect(def.defaultProps).toEqual({ narrationFile: "test.mp3" });
    expect(def.folder).toBe("Content");
  });

  it("registers multiple compositions in insertion order", () => {
    defineComposition({ id: "Alpha", component: MockComponent, fps: 30, width: 1080, height: 1920, durationInFrames: 100, defaultProps: {} });
    defineComposition({ id: "Beta",  component: MockComponent, fps: 30, width: 1080, height: 1920, durationInFrames: 200, defaultProps: {} });
    defineComposition({ id: "Gamma", component: MockComponent, fps: 30, width: 1080, height: 1920, durationInFrames: 300, defaultProps: {} });

    const ids = getRegistry().map((d) => d.id);
    expect(ids).toEqual(["Alpha", "Beta", "Gamma"]);
  });
});

// ── Idempotency ────────────────────────────────────────────────────────────

describe("defineComposition — idempotency", () => {
  it("silently replaces prior registration for the same id", () => {
    defineComposition({
      id: "Dupe",
      component: MockComponent,
      fps: 30,
      width: 1080,
      height: 1920,
      durationInFrames: 100,
      defaultProps: { v: 1 },
    });

    defineComposition({
      id: "Dupe",
      component: MockComponent,
      fps: 30,
      width: 1080,
      height: 1920,
      durationInFrames: 999, // updated
      defaultProps: { v: 2 },
    });

    const registry = getRegistry();
    expect(registry).toHaveLength(1);
    expect(registry[0].durationInFrames).toBe(999);
    expect(registry[0].defaultProps).toEqual({ v: 2 });
  });

  it("does not grow the registry on re-registration", () => {
    for (let i = 0; i < 5; i++) {
      defineComposition({
        id: "Repeated",
        component: MockComponent,
        fps: 30,
        width: 1080,
        height: 1920,
        durationInFrames: i * 100 + 1,
        defaultProps: {},
      });
    }
    expect(getRegistry()).toHaveLength(1);
  });
});

// ── Empty state ────────────────────────────────────────────────────────────

describe("defineComposition — empty registry", () => {
  it("getRegistry() returns empty array before any registrations", () => {
    expect(getRegistry()).toEqual([]);
  });
});
