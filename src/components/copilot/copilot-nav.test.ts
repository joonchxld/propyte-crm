import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

// #997 — sistemas@: «al cambiar a Vencidas, se mueve todo a la derecha». Mi día usaba un ancho y
// Vencidas otro, así que al cambiar de pestaña todo se recentraba. Las pestañas de Copilot usan el
// mismo contenedor (ANCHO_COPILOT) y ninguna pone su propio ancho de página.
const raiz = path.resolve(__dirname, "../../app/(dashboard)/copilot");
const PAGINAS = ["page.tsx", "vencidas/page.tsx"];

describe("Copilot — las pestañas no brincan", () => {
  for (const archivo of PAGINAS) {
    it(`${archivo} usa el contenedor común`, () => {
      const src = fs.readFileSync(path.join(raiz, archivo), "utf8");
      expect(src).toContain("className={ANCHO_COPILOT}");
      expect(src, "ancho de página propio").not.toMatch(/mx-auto max-w-/);
    });
  }
});
