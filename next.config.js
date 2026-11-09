/** @type {import('next').NextConfig} */
const nextConfig = {
  // Next 15: esta clave se graduó de "experimental" y se movió a la raíz
  // (antes era experimental.serverComponentsExternalPackages).
  serverExternalPackages: ["@prisma/client", "bcryptjs", "sharp"],
  experimental: {
    // Reduce el uso de memoria pico de Webpack durante `next build` a cambio de un
    // ligero aumento en el tiempo de compilación. Disponible desde Next 15.0.0,
    // documentado como "de bajo riesgo" aunque sigue marcado experimental. Se activó
    // tras un OOM real (`JavaScript heap out of memory`) en el build de la migración
    // #805 en Windows — ver COMO-APLICAR-805 para el resto de los pasos de mitigación.
    webpackMemoryOptimizations: true,
    // #906 — tope de workers de `next build`. Sin esto Next arranca (núcleos − 1) workers
    // para «Collecting page data» y «Generating static pages»; el host de build de hPanel
    // expone 64 núcleos → 63 workers, cada uno con sus hilos de SWC (Rust), y el contenedor
    // agota su límite de hilos: `OS can't spawn worker thread: Resource temporarily
    // unavailable (os error 11)` → SIGABRT. Desde el 2026-10-19 tumba los builds del CRM y
    // de la web, incluso de un commit que el 16-oct había compilado bien. Si con 4 vuelve a
    // fallar, bajar a 2. No afecta al servidor en producción, solo al build. Desde 2026-11 se
    // compila en el VPS (4 núcleos; el contenedor de build tiene tope de 2 CPU): se deja igual.
    cpus: 4,
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-XSS-Protection", value: "1; mode=block" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(self), geolocation=()" },
        ],
      },
    ];
  },
};

module.exports = nextConfig;
