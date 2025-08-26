const fs = require('fs');
const path = require('path');
const Crawler = require('crawler');
const jsdom = require('jsdom');
const request = require('request');
const mkdirp = require('mkdirp');
const debug = require('debug')('crawler');
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

let PQueue;
(async () => {
  try {
    const pQueueModule = await import('p-queue');
    PQueue = pQueueModule.default;
    startCrawler();
  } catch (err) {
    console.error('❌ Failed to load p-queue:', err);
    process.exit(1);
  }
})();

class Core {
  constructor(siteUrl, novelId) {
    const url = new URL(siteUrl);
    this.hostname = url.hostname;
    this.host = siteUrl.replace(/\/$/, '');
    this.novelId = novelId;

    // 目录结构
    this.projectRoot = path.resolve(__dirname, '../bqg');
    this.outputDir = path.join(this.projectRoot, novelId);
    this.assetsDir = path.join(this.outputDir, 'assets');

    this.pageSum = 0;
    this.downloadNum = 0;
    this.visited = new Set();
    this.srcs = new Set();
    this.downloadedAssets = new Set();

    // 并发控制
    this.pageQueue = new PQueue({ concurrency: 5, interval: 2000 });
    this.assetQueue = new PQueue({ concurrency: 3 });

    this.c = null;
    this.ensureProjectDir();
    this.initCrawler();
  }

  ensureProjectDir() {
    mkdirp.sync(this.outputDir);
    mkdirp.sync(this.assetsDir);
  }

  start() {
    const startUrl = `${this.host}/${this.novelId}`;
    pageStart.info(`🚀 开始抓取小说: ${startUrl}`);
    this.c.queue(startUrl);

    this.pageQueue.onEmpty().then(() => {
      console.log('=== 所有页面抓取任务已完成 ===');
      console.log(`抓取页面数: ${this.pageSum}`);
      console.log(`下载资源数: ${this.downloadNum}`);
    });
    this.assetQueue.onIdle().then(() => {
      console.log('=== 所有资源下载任务已完成 ===');
    });
  }

  initCrawler() {
    this.c = new Crawler({
      jQuery: jsdom,
      forceUTF8: true,
      timeout: 100000,
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36',
      callback: async (error, res, done) => {
        const url = res?.options?.uri || 'Unknown';
        if (error) {
          pageEnd.error(`请求失败: ${url}`, error);
          done();
          return;
        }
        const { options } = res;
        const dom = new jsdom.JSDOM(res.body);
        const currentUrl = options.uri;

        try {
          if (currentUrl === `${this.host}/${this.novelId}`) {
            await this.processIndexPage(dom, currentUrl);
          } else {
            await this.processChapterPage(dom, currentUrl);
          }
        } catch (err) {
          pageEnd.error(`处理页面失败: ${currentUrl}`, err);
        } finally {
          done();
        }
      }
    });
  }

  async processIndexPage(dom, url) {
    const { document } = dom.window;
    pageEnd.info(`目录页: ${decodeURI(url)}`);
    this.getUrls(document);

    const title = document.querySelector('title')?.textContent?.trim() || '小说目录';
    const html = document.body.innerHTML;
    const content = await this.processPageContent(html, title, url);

    const indexPath = path.join(this.outputDir, 'index.html');
    await this.writePage(indexPath, content);
    debug('✅ 目录页生成成功:', indexPath);
  }

  async processChapterPage(dom, url) {
    const { document } = dom.window;
    pageEnd.info(`章节: ${decodeURI(url)}`);

    const title = document.querySelector('title')?.textContent?.trim() || '章节';
    const html = document.body.innerHTML;
    const fileName = path.basename(new URL(url).pathname) || 'chapter.html';
    const chapterPath = path.join(this.outputDir, fileName);
    const content = await this.processPageContent(html, title, url);

    await this.writePage(chapterPath, content);
    debug('✅ 章节生成成功:', chapterPath);
  }

  getUrls(document) {
    const urls = document.querySelectorAll('.listmain a');
    urls.forEach(urlEl => {
      const href = urlEl.getAttribute('href');
      if (!href) return;

      const absoluteUrl = new URL(href, this.host).href;
      if (this.visited.has(absoluteUrl)) return;

      this.visited.add(absoluteUrl);
      this.pageSum++;

      this.pageQueue.add(() => {
        pageStart.info(`章节加入队列: ${decodeURI(absoluteUrl)}`);
        this.c.queue(absoluteUrl);
      });
    })
    debug(`📊 共发现 ${this.pageSum} 个章节，已加入队列。`);
  }

  /**
   * 处理页面内容，提取资源、清理HTML、下载资源
   */
  async processPageContent(html, title, currentUrl) {
    // 1. 修复协议
    html = html.replace(/(?<!:)(\/\/www)/g, 'http:$1');

    // 2. 提取资源链接（img、link、script、video、audio等）
    const dom = new jsdom.JSDOM(html);
    const { document } = dom.window;
    const assetTypes = {
      img: ['src', 'data-src', 'data-original', 'lazy-src', 'data-full-url'],
      link: ['href'],
      script: ['src'],
      video: ['src'],
      source: ['src'],
      iframe: ['src'],
      audio: ['src']
    };
    const ASSET_REGEX = /\.(jpe?g|png|gif|webp|svg|css|js|mp4|webm|ogg|wav|woff2?|ttf|ico|bmp|tiff?|pdf|docx?|xlsx?|pptx?|zip|rar|3gp)(\?.*)?$/i;
    const currentHostname = new URL(currentUrl).hostname;

    // 提取资源并替换路径
    for (const [tag, attrs] of Object.entries(assetTypes)) {
      document.querySelectorAll(tag).forEach(el => {
        attrs.forEach(attr => {
          const src = el.getAttribute(attr);
          if (!src) return;
          try {
            const absoluteUrl = new URL(src, currentUrl).href;
            const urlObj = new URL(absoluteUrl);

            if (urlObj.hostname !== currentHostname) return;
            if (!ASSET_REGEX.test(absoluteUrl)) return;

            const localPath = this.getLocalAssetPath(absoluteUrl);
            if (!this.downloadedAssets.has(absoluteUrl)) {
              this.downloadedAssets.add(absoluteUrl);
              this.downloadImg(absoluteUrl, localPath);
            }
            const relativePath = path.relative(this.outputDir, localPath).replace(/\\/g, '/');
            el.setAttribute(attr, `assets/${path.basename(relativePath)}`);
          } catch (e) {
            debug(`Invalid resource URL: ${src}`, e.message);
          }
        });
      });
    }

    // 处理内联 <style> 标签中的 url()
    document.querySelectorAll('style').forEach(styleEl => {
      const cssText = styleEl.textContent;
      if (!cssText || cssText.trim() === '') return;
      const URL_REGEX = /url\(\s*['"]?([^'")]+?)['"]?\s*\)/gi;
      const replacements = [];
      for (const match of cssText.matchAll(URL_REGEX)) {
        const fullMatch = match[0];
        const urlInCss = match[1];
        try {
          const absoluteUrl = new URL(urlInCss, currentUrl).href;
          const urlObj = new URL(absoluteUrl);
          if (urlObj.hostname !== currentHostname) continue;
          if (!ASSET_REGEX.test(absoluteUrl)) continue;
          const localPath = this.getLocalAssetPath(absoluteUrl);
          if (!this.downloadedAssets.has(absoluteUrl)) {
            this.downloadedAssets.add(absoluteUrl);
            this.downloadImg(absoluteUrl, localPath);
          }
          const relativePath = path.relative(this.outputDir, localPath).replace(/\\/g, '/');
          const newUrlStr = `url(assets/${path.basename(relativePath)})`;
          replacements.push({ original: fullMatch, replacement: newUrlStr });
        } catch (e) {
          debug(`Invalid URL in CSS: ${urlInCss}`, e.message);
        }
      }
      let newCssText = cssText;
      for (const { original, replacement } of replacements) {
        newCssText = newCssText.replace(original, replacement);
      }
      if (newCssText !== cssText) {
        styleEl.textContent = newCssText;
      }
    });

    // 清理内联 <script> 内容
    document.querySelectorAll('script').forEach(scriptEl => {
      if (!scriptEl.getAttribute('src')) {
        scriptEl.textContent = '';
      }
    });

    // 删除 srcset 属性
    document.querySelectorAll('[srcset]').forEach(el => el.removeAttribute('srcset'));

    // 删除除 stylesheet 外的 link
    document.querySelectorAll('link').forEach(linkEl => {
      if (linkEl.getAttribute('rel') !== 'stylesheet') {
        linkEl.remove();
      }
    });

    // 还可以根据需要删除 meta、广告等
    // ...

    // 返回处理后的 HTML
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <link rel="stylesheet" href="assets/style.css">
</head>
<body>
  ${document.body.innerHTML}
</body>
</html>`;
  }

  /**
   * 获取资源的本地存储路径
   */
  getLocalAssetPath(url) {
    try {
      const parsedUrl = new URL(url);
      let { pathname } = parsedUrl;

      if (pathname === '/' || pathname === '') {
        pathname = '/index';
      }
      const cleanPathname = pathname.split('?')[0];
      const decodedPathname = decodeURIComponent(cleanPathname);
      return path.join(this.assetsDir, path.basename(decodedPathname));
    } catch (e) {
      console.error(`解析URL失败: ${url}`, e);
      return path.join(this.assetsDir, `unknown_${Date.now()}.bin`);
    }
  }

  /**
   * 下载图片/资源
   */
  downloadImg(imgUrl, fileName) {
    this.assetQueue.add(() => this.downloadWithRetry(imgUrl, fileName));
  }

  /**
   * 带重试机制的资源下载
   */
  async downloadWithRetry(imgUrl, fileName) {
    const maxRetries = 3;
    if (fs.existsSync(fileName)) {
      assetsEnd.info(`File already exists, skipping download: ${fileName}`);
      this.downloadNum++;
      return;
    }
    const dirName = path.dirname(fileName);
    if (!fs.existsSync(dirName)) {
      try {
        mkdirp.sync(dirName);
      } catch (e) {
        assetsEnd.error(`Failed to create directory ${dirName}:`, e);
        return;
      }
    }
    for (let i = 0; i < maxRetries; i++) {
      try {
        assetsStart.info(`Downloading: ${decodeURI(imgUrl)}`);
        await new Promise((resolve, reject) => {
          const writeStream = fs.createWriteStream(fileName);
          const requestStream = request.get(encodeURI(imgUrl));
          requestStream.on('error', reject);
          writeStream.on('error', (err) => {
            fs.unlink(fileName, (unlinkErr) => {
              if (unlinkErr) console.error('Failed to delete incomplete file:', unlinkErr);
            });
            reject(err);
          });
          writeStream.on('finish', resolve);
          requestStream.pipe(writeStream);
        });
        assetsEnd.info(`Downloaded: ${decodeURI(imgUrl)}`);
        this.downloadNum++;
        return;
      } catch (error) {
        const delay = 2000 * Math.pow(2, i);
        assetsEnd.warn(`Download failed (${i + 1}/${maxRetries}): ${decodeURI(imgUrl)}, retrying in ${delay}ms. Error:`, error.message);
        if (i === maxRetries - 1) {
          assetsEnd.error(`Download ultimately failed: ${decodeURI(imgUrl)}`);
          break;
        }
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }

  /**
   * 写入页面文件
   */
  async writePage(filePath, htmlContent) {
    try {
      await fs.promises.writeFile(filePath, htmlContent, 'utf8');
      debug(`📄 页面已保存: ${filePath}`);
    } catch (err) {
      console.error('写入文件失败:', err);
      throw err;
    }
  }
}

function startCrawler() {
  const core = new Core('https://www.bqgda.cc/books', '136187');
  core.start();
  debug('>>> core', core);
}