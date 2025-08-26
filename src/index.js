const fs = require('fs'); // 保留完整的 fs 模块
const path = require('path');
const Crawler = require('crawler');
const jsdom = require('jsdom');
const request = require('request');
const mkdirp = require('mkdirp');
const debug = require('debug')('crawler');

// ======== 日志配置 (保持您的原有设计) ========
const log4js = require('log4js');

log4js.configure({
  appenders: {
    pageStart: { type: 'file', filename: path.resolve(__dirname, '../logs2/pageStart.log'), category: 'pageStart' },
    pageEnd: { type: 'file', filename: path.resolve(__dirname, '../logs2/pageEnd.log'), category: 'pageEnd' },
    assetsStart: { type: 'file', filename: path.resolve(__dirname, '../logs2/assetsStart.log'), category: 'assetsStart' },
    assetsEnd: { type: 'file', filename: path.resolve(__dirname, '../logs2/assetsEnd.log'), category: 'assetsEnd' },
    console: { type: 'console' }
  },
  categories: {
    default: { appenders: ['console', 'pageStart'], level: 'trace' },
    pageEnd: { appenders: ['console', 'pageEnd'], level: 'trace' },
    pageStart: { appenders: ['console', 'pageStart'], level: 'trace' },
    assetsStart: { appenders: ['console', 'assetsStart'], level: 'trace' },
    assetsEnd: { appenders: ['console', 'assetsEnd'], level: 'trace' },
  }
});

const pageStart = log4js.getLogger('pageStart');
const pageEnd = log4js.getLogger('pageEnd');
const assetsStart = log4js.getLogger('assetsStart');
const assetsEnd = log4js.getLogger('assetsEnd');
// =============================================

let PQueue;

// ======== 动态加载 p-queue (ESM 兼容) ========
(async () => {
  try {
    const pQueueModule = await import('p-queue');
    PQueue = pQueueModule.default;
    startCrawler(); // 成功加载后启动
  } catch (err) {
    console.error('❌ Failed to load p-queue:', err);
    process.exit(1);
  }
})();

// ==================== 核心爬虫类 ====================
class Core {
  constructor(siteUrl, novelId) {
    const url = new URL(siteUrl);
    this.hostname = url.hostname;
    this.host = siteUrl.replace(/\/$/, ''); // 确保无尾斜杠
    this.novelId = novelId;
    this.pageSum = 0;
    this.downloadNum = 0;
    this.visited = new Set();        // 防止重复抓取页面
    this.srcs = new Set();           // 记录已计划下载的资源 URL
    this.downloadedAssets = new Set(); // 防止重复下载资源

    // ✅ 项目根目录为 /bqg/小说ID
    this.projectRoot = path.resolve(__dirname, '../bqg'); // 根目录
    this.outputDir = path.join(this.projectRoot, novelId); // 输出目录：/bqg/52_52542
    this.assetsDir = path.join(this.outputDir, 'assets');  // 资源目录：/bqg/52_52542/assets

    // ✅ 使用 p-queue 控制并发
    this.pageQueue = new PQueue({ concurrency: 5, interval: 2000 }); // 每2秒最多5个页面
    this.assetQueue = new PQueue({ concurrency: 3 }); // 最多3个资源并发下载

    this.currentPage = {
      title: '',
      chapters: []
    };

    this.c = null;
    this.initCrawler();
    this.ensureProjectDir();

    // ✅ 实例化完成后立即启动抓取
    this.start(); // 不需要传 novelId，因为 this.novelId 已经存在
  }

  // 确保输出目录存在
  ensureProjectDir() {
    mkdirp.sync(this.outputDir);
    mkdirp.sync(this.assetsDir);
  }

  start() {
    const startUrl = `${this.host}/${this.novelId}`;
    console.log(`🚀 开始抓取小说: ${startUrl}`);
    this.c.queue(startUrl);
  }

  initCrawler() {
    this.c = new Crawler({
      jQuery: jsdom,
      forceUTF8: true,
      timeout: 100000,
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36',
      callback: async (error, res, done) => {
        if (error) {
          const url = res?.options?.uri || 'Unknown';
          pageEnd.error(`请求失败: ${url}`, error);
          done();
          return;
        }

        const { $, options } = res;
        const currentUrl = options.uri;

        try {
          if (currentUrl === `${this.host}/${this.novelId}`) {
            await this.processIndexPage($, currentUrl);
          } else {
            await this.processChapterPage($, currentUrl);
          }
        } catch (err) {
          pageEnd.error(`处理页面失败: ${currentUrl}`, err);
        } finally {
          done();
        }
      }
    });
  }

  async processIndexPage($, url) {
    pageEnd.info(decodeURI(url));
    const urls = $('#list a');
    this.getUrls($, urls);

    const title = $('title').text().trim() || '小说目录';
    const html = $('body').html();
    const content = await this.formatContent(html, title);

    const indexPath = path.join(this.outputDir, 'index.html');
    await this.writePage(indexPath, content);
    console.log('✅ 目录页生成成功:', indexPath);
  }

  async processChapterPage($, url) {
    pageEnd.info(decodeURI(url));

    const title = $('title').text().trim() || '章节';
    const html = $('body').html();
    const content = await this.formatContent(html, title);

    const filename = path.basename(new URL(url).pathname) || 'chapter.html';
    const chapterPath = path.join(this.outputDir, filename);
    await this.writePage(chapterPath, content);

    console.log('✅ 章节生成成功:', chapterPath);
  }

  getUrls($, urls) {
    for (let i = 0; i < urls.length; i++) {
      const $url = $(urls[i]);
      const href = $url.attr('href');
      if (!href) continue;

      const absoluteUrl = new URL(href, this.host).href;
      if (this.visited.has(absoluteUrl)) continue;

      this.visited.add(absoluteUrl);
      const name = decodeURI($url.text().trim());
      const page = path.basename(href);

      this.currentPage.chapters.push({ name, url: absoluteUrl, page, isLoaded: true });
      this.pageSum++;

      // ✅ 使用 pageQueue 控制页面抓取并发
      this.pageQueue.add(() => {
        pageStart.info(decodeURI(absoluteUrl));
        this.c.queue(absoluteUrl);
      });
    }

    console.log(`📊 共发现 ${this.pageSum} 个章节，已加入队列。`);
  }

  async formatContent(html, title) {
    // 修复协议
    html = html.replace(/(?<!:)(\/\/www)/g, 'http:$1');

    // 提取资源
    const resourceRegex = /https?:\/\/[^"\s]*\.(jpe?g|png|gif|svg|css|js|mp4|webp)[^"\s]*/gi;
    const matches = html.match(resourceRegex) || [];

    for (const src of matches) {
      if (this.srcs.has(src)) continue;
      this.srcs.add(src);

      // ✅ 加入 assetQueue 控制下载并发
      await this.assetQueue.add(async () => {
        if (this.downloadedAssets.has(src)) return;

        const fileName = path.basename(new URL(src).pathname);
        const assetPath = path.join(this.assetsDir, fileName);

        // 避免重复下载
        try {
          await fs.access(assetPath);
          this.downloadedAssets.add(src);
          assetsEnd.info(`✅ 资源已存在，跳过: ${decodeURI(src)}`);
          return;
        } catch (error) {
          console.log(`⏬ 开始下载资源: ${decodeURI(src)}`);
        }

        assetsStart.info(decodeURI(src));
        await this.downloadWithRetry(src, assetPath);
        this.downloadedAssets.add(src);
      });
    }

    // 清理 HTML
    html = html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
    html = html.replace(/https?:\/\/[^"\s]*/g, match => match.includes(this.hostname) ? match : '');
    html = html.replace(/&nbsp;/g, ' ');

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title}</title>
    <link rel="stylesheet" href="assets/biquge.css">
</head>
<body>
    ${html}
</body>
</html>`;
  }

  downloadWithRetry(imgUrl, filePath, maxRetries = 3) {
    return new Promise((resolve, reject) => {
      let attempts = 0;

      const download = () => {
        const stream = request(encodeURI(imgUrl));
        const fileStream = fs.createWriteStream(filePath);

        stream.pipe(fileStream);

        stream.on('error', (err) => {
          fileStream.close();
          attempts++;
          if (attempts <= maxRetries) {
            const delay = Math.pow(2, attempts) * 1000;
            assetsEnd.error(`🔁 下载失败 (第${attempts}次): ${decodeURI(imgUrl)} - ${err.message}`);
            setTimeout(download, delay);
          } else {
            assetsEnd.error(`❌ 下载失败 (已重试${maxRetries}次): ${decodeURI(imgUrl)}`);
            fs.unlink(filePath).catch(() => { });
            reject(err);
          }
        });

        fileStream.on('finish', () => {
          assetsEnd.info(`✅ 下载成功: ${decodeURI(imgUrl)}`);
          this.downloadNum++;
          resolve();
        });
      };

      download();
    });
  }

  async writePage(filePath, content) {
    try {
      await fs.promises.writeFile(filePath, content, 'utf8');
      debug(`📄 页面已保存: ${filePath}`);
    } catch (err) {
      console.error('写入文件失败:', err);
      throw err;
    }
  }
}

// ======== 启动函数 (由 p-queue 加载后调用) ========
function startCrawler() {
  const core = new Core('https://www.bqgda.cc/books', '136187'); // 自动启动
  console.log('>>> core', core)
}