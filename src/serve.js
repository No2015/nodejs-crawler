// src/serve.js
const path = require('path');
const fs = require('fs');
const express = require('express');

const app = express();

// 使用相对路径定位 dist 目录（相对于当前文件 serve.js）
const DIST_PATH = path.join(__dirname, '..', 'dist');

// 检查 dist 目录是否存在
if (!fs.existsSync(DIST_PATH)) {
  console.error(`静态文件目录不存在: ${DIST_PATH}`);
  process.exit(1);
}

// 🚀 根路径重定向到 /index/
app.get('/', (req, res) => {
  res.redirect(302, '/index/');  // 302 临时重定向
});

// 启用静态文件服务，Express 会自动处理子目录中的 index.html
app.use(express.static(DIST_PATH));

// 可选：如果你想让访问 /index 或 /category 时自动跳转到对应 index.html（即使没加 /）
// Express 的 static 中间件默认支持目录下的 index.html，所以其实不需要额外配置

// 如果你希望支持“目录浏览”（即列出文件夹内容），可以使用第三方库，如 `serve-index`
// 安装：npm install serve-index
// const serveIndex = require('serve-index');
// app.use(express.static(DIST_PATH));
// app.use(serveIndex(DIST_PATH, { icons: true }));

// 错误处理：如果上面都没匹配，返回 404
app.use((req, res) => {
  res.status(404).send('页面未找到');
});

const PORT = 8081;
const HOST = 'localhost';

const server = app.listen(PORT, HOST, () => {
  console.log(`✅ 静态服务器已启动，访问地址: http://${HOST}:${PORT}/`);
  console.log(`📁 服务根目录: ${DIST_PATH}`);
});

console.log('>>> server', server)