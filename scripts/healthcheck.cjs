const http = require("http");

const port = Number(process.env.PORT || 3000);

const req = http.request({
  hostname: "127.0.0.1",
  port,
  path: "/api/health",
  method: "GET",
  timeout: 4000
}, res => {
  if (res.statusCode >= 200 && res.statusCode < 300) {
    process.exit(0);
  } else {
    process.exit(1);
  }
});

req.on("error", () => process.exit(1));
req.on("timeout", () => { req.destroy(); process.exit(1); });
req.end();
