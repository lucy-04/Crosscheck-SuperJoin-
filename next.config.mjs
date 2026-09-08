/** @type {import('next').NextConfig} */
const nextConfig = {
  // better-sqlite3 is a native module and pdfjs-dist ships a Node-only build; both
  // must stay external to the server bundle rather than being traced/bundled.
  serverExternalPackages: ["better-sqlite3", "pdfjs-dist"],
};

export default nextConfig;
