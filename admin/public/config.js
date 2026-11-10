// Konfigurasi runtime. Di container, Caddy mengisi nilainya dari environment (directive templates).
window.__PACETARA__ = { apiBaseUrl: "{{env "API_PUBLIC_URL"}}" };
