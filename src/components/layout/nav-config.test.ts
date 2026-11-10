import { describe, it, expect } from "vitest";
import { UserRole } from "@prisma/client";
import { navGroups, userMenuItems, visibleNavItems, visibleUserMenuItems } from "./nav-config";

// AUD-20260710-05 (y BUG TEAM_LEADER jun-2026): roles del enum sin ningún item de nav
// → sidebar vacío, el usuario entra pero no puede navegar. Este test fija la clase entera:
// TODO rol del enum UserRole debe ver al menos un item.
describe("nav-config — cobertura de roles del sidebar", () => {
  it("todo rol del enum UserRole ve al menos 1 item de navegación", () => {
    for (const role of Object.values(UserRole)) {
      const items = visibleNavItems(role);
      expect(items.length, `rol sin sidebar: ${role}`).toBeGreaterThan(0);
    }
  });

  it("los roles referenciados en navGroups existen en el enum (sin typos)", () => {
    const valid = new Set(Object.values(UserRole) as string[]);
    for (const group of navGroups) {
      for (const item of group.items) {
        for (const role of item.roles) {
          expect(valid.has(role), `rol inexistente "${role}" en item ${item.href}`).toBe(true);
        }
      }
    }
  });

  it("MANTENIMIENTO no ve páginas que lo redirigen (conexiones/configuracion)", () => {
    const hrefs = [
      ...visibleNavItems("MANTENIMIENTO"),
      ...visibleUserMenuItems("MANTENIMIENTO"),
    ].map((i) => i.href);
    expect(hrefs).not.toContain("/conexiones");
    expect(hrefs).not.toContain("/configuracion");
  });
});

// Las opciones de sistema se movieron del sidebar al menú del nombre (ago-2026).
// Mover de superficie NO debe cambiar quién las ve ni dejar rutas huérfanas.
describe("nav-config — menú del nombre (opciones de sistema)", () => {
  it("las 4 opciones de sistema salieron del sidebar", () => {
    const sidebarHrefs = navGroups.flatMap((g) => g.items.map((i) => i.href));
    for (const href of ["/settings", "/configuracion", "/conexiones", "/duplicados"]) {
      expect(sidebarHrefs, `${href} sigue en el sidebar`).not.toContain(href);
    }
  });

  it("y viven en el menú del nombre, sin duplicarse con el sidebar", () => {
    const sidebarHrefs = new Set(navGroups.flatMap((g) => g.items.map((i) => i.href)));
    for (const item of userMenuItems) {
      expect(sidebarHrefs.has(item.href), `${item.href} duplicado en ambas superficies`).toBe(false);
    }
    expect(userMenuItems.map((i) => i.href)).toEqual([
      "/settings",
      "/configuracion",
      "/conexiones",
      "/duplicados",
      "/admin/comentarios",
    ]);
  });

  it("los roles del menú existen en el enum (sin typos)", () => {
    const valid = new Set(Object.values(UserRole) as string[]);
    for (const item of userMenuItems) {
      for (const role of item.roles) {
        expect(valid.has(role), `rol inexistente "${role}" en item ${item.href}`).toBe(true);
      }
    }
  });

  it("todo rol conserva su acceso a Mi Perfil (era 'Mi Config' en el sidebar)", () => {
    for (const role of Object.values(UserRole)) {
      const hrefs = visibleUserMenuItems(role).map((i) => i.href);
      expect(hrefs, `rol sin Mi Perfil: ${role}`).toContain("/settings");
    }
  });

  it("un asesor NO ve las opciones de administración", () => {
    const hrefs = visibleUserMenuItems("ASESOR_SR").map((i) => i.href);
    expect(hrefs).toEqual(["/settings"]);
  });

  it("ADMIN ve las 5", () => {
    expect(visibleUserMenuItems("ADMIN")).toHaveLength(5);
  });

  // El motivo de existir de /admin/comentarios: MARKETING no entra a /admin
  // (esa página exige rol de administración), pero sí a esta puerta. Si alguien
  // la quita del menú, la diseñadora se queda sin forma de llegar.
  it("MARKETING ve Comentarios, pero ninguna otra opción de administración", () => {
    const hrefs = visibleUserMenuItems("MARKETING").map((i) => i.href);
    expect(hrefs).toContain("/admin/comentarios");
    expect(hrefs).not.toContain("/configuracion");
    expect(hrefs).not.toContain("/duplicados");
  });

  it("un asesor no ve Comentarios", () => {
    expect(visibleUserMenuItems("ASESOR_JR").map((i) => i.href)).not.toContain("/admin/comentarios");
  });
});

// El orden del sidebar es el pedido explícito de Luis (flujo del día del asesor):
// si alguien lo reordena por accidente, este test lo dice.
describe("nav-config — orden del sidebar", () => {
  it("el grupo operativo es Hoy → Inbox → Agenda → Copilot (el Dashboard se retiró en #890)", () => {
    expect(navGroups[0].title).toBeNull();
    expect(navGroups[0].items.map((i) => i.label)).toEqual(["Hoy", "Inbox", "Agenda", "Copilot"]);
  });

  it("Ventas sigue el embudo: Contactos → Negocios → Cotizaciones", () => {
    expect(navGroups[1].title).toBe("Ventas");
    expect(navGroups[1].items.slice(0, 3).map((i) => i.label)).toEqual([
      "Contactos",
      "Negocios",
      "Cotizaciones",
    ]);
  });

  it("#957: el menú Negocios solo lo ven administración y dirección hasta la #958", () => {
    const negocios = navGroups.flatMap((g) => g.items).find((i) => i.href === "/pipeline");
    expect(negocios?.roles).toEqual(["DIRECTOR"]); // ADMIN ve todo el menú (sidebar.tsx)
  });

  it("'Pipeline' se llama 'Negocios' pero la ruta /pipeline NO cambió", () => {
    const negocios = navGroups.flatMap((g) => g.items).find((i) => i.href === "/pipeline");
    expect(negocios?.label).toBe("Negocios");
    const labels = navGroups.flatMap((g) => g.items).map((i) => i.label);
    expect(labels).not.toContain("Pipeline");
  });

  it("Desempeño abre con Metas y cierra con Reportes", () => {
    expect(navGroups[2].title).toBe("Desempeño");
    const labels = navGroups[2].items.map((i) => i.label);
    expect(labels[0]).toBe("Metas");
    expect(labels[labels.length - 1]).toBe("Reportes");
  });

  it("#926: Reclutamiento vive en Desempeño y solo lo ven ADMIN, DIRECTOR y GERENTE (datos personales)", () => {
    expect(navGroups[2].items.map((i) => i.href)).toContain("/reclutamiento");
    for (const role of Object.values(UserRole)) {
      const ve = visibleNavItems(role).some((i) => i.href === "/reclutamiento");
      expect(ve, role).toBe(["ADMIN", "DIRECTOR", "GERENTE"].includes(role));
    }
  });

  it("#993: Cadencias vive en Desempeño y solo lo ven ADMIN, DIRECTOR y GERENTE", () => {
    expect(navGroups[2].items.map((i) => i.href)).toContain("/cadencias");
    for (const role of Object.values(UserRole)) {
      const ve = visibleNavItems(role).some((i) => i.href === "/cadencias");
      expect(ve, role).toBe(["ADMIN", "DIRECTOR", "GERENTE"].includes(role));
    }
  });
});
