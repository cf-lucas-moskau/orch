export type Rect = { x: number; y: number; width: number; height: number };
export type Point = { x: number; y: number };

// The pet's box inside the window (bottom right, see PET in App.tsx). Only it has to stay on screen; the rest of
// the window is transparent, so the pet can still sit flush against any screen edge.
const pet = (size: { width: number; height: number }) => ({ dx: size.width - 136, dy: size.height - 130, w: 120, h: 120 });

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
const overlap = (a: Rect, b: Rect) =>
  Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
const dist = (p: Point, r: Rect) => Math.hypot(p.x - clamp(p.x, r.x, r.x + r.width), p.y - clamp(p.y, r.y, r.y + r.height));

// Where the window opens: the saved spot moved onto the display it overlaps most (or the nearest one, after a
// monitor was unplugged), so the whole pet is visible; bottom right of the primary display without a saved spot.
export function placeWindow(saved: unknown, size: { width: number; height: number }, areas: Rect[], primary: Rect): Point {
  const p = pet(size);
  const s = saved as Partial<Point> | null;
  if (!s || !Number.isFinite(s.x) || !Number.isFinite(s.y) || !areas.length)
    return { x: primary.x + primary.width - size.width - 8, y: primary.y + primary.height - size.height };
  const box: Rect = { x: s.x! + p.dx, y: s.y! + p.dy, width: p.w, height: p.h };
  const centre = { x: box.x + p.w / 2, y: box.y + p.h / 2 };
  const area = [...areas].sort((a, b) => overlap(box, b) - overlap(box, a) || dist(centre, a) - dist(centre, b))[0];
  return {
    x: clamp(box.x, area.x, area.x + area.width - p.w) - p.dx,
    y: clamp(box.y, area.y, area.y + area.height - p.h) - p.dy,
  };
}
