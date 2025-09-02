const fs = require('fs');
const path = require('path');
const Crawler = require('crawler');
const request = require('request');
const mkdirp = require('mkdirp');
const debug = require('debug')('crawler');
// const PQueue = require('p-queue');
let PQueue;
(async () => {
  try {
    const pQueueModule = await import('p-queue');
    PQueue = pQueueModule.default; // ESM 模块的默认导出通常在 .default 上
  } catch (err) {
    console.error('Failed to load p-queue:', err);
    process.exit(1);
  }

  // 只有在 PQueue 加载成功后，才启动爬虫
  startCrawler();
})();

// ==================== 日志配置 (保持不变) ====================
const log4js = require('log4js');

log4js.configure({
  "appenders": {
    pageStart: {
      "type": "file",
      "filename": path.resolve(__dirname, '../logs/pageStart.log'),
      "category": "pageStart"
    },
    pageEnd: {
      "type": "file",
      "filename": path.resolve(__dirname, '../logs/pageEnd.log'),
      "category": "pageEnd"
    },
    assetsStart: {
      "type": "file",
      "filename": path.resolve(__dirname, '../logs/assetsStart.log'),
      "category": "assetsStart"
    },
    assetsEnd: {
      "type": "file",
      "filename": path.resolve(__dirname, '../logs/assetsEnd.log'),
      "category": "assetsEnd"
    },
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

// ==================== 核心爬虫类 ====================
class Core {
  constructor(siteUrl) {
    const url = new URL(siteUrl);
    this.hostname = url.hostname;
    this.project = siteUrl.replace(/\/$/, ''); // 确保没有尾部斜杠
    this.startUrl = siteUrl;
    this.pageSum = 0;
    this.downloadNum = 0;
    this.visited = new Set(); // 防止重复抓取
    this.srcs = []; // 记录已计划下载的资源

    this.downloadedAssets = new Set();

    // 使用队列控制并发
    this.pageQueue = new PQueue({ concurrency: 5, interval: 2000 }); // 每2秒最多5个页面请求
    this.assetQueue = new PQueue({ concurrency: 3 }); // 最多3个资源下载并发

    this.c = null;
    this.ensureProjectDir();
  }

  /**
   * 确保项目输出目录存在
   */
  ensureProjectDir() {
    const dir = path.join(__dirname, '..', 'dist');
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  /**
   * 启动爬虫
   * @param {string|string[]} url - 起始URL
   */
  start(url = '') {
    this.startUrl = url || this.project;
    this.initCrawler();

    if (typeof this.startUrl === 'string') {
      this.c.queue(this.startUrl);
    } else if (Array.isArray(this.startUrl)) {
      this.startUrl.forEach((item) => {
        this.c.queue(item);
      });
    } else {
      throw new Error('Invalid site_url type. Must be string or array.');
    }
  }

  /**
   * 初始化爬虫实例
   */
  initCrawler() {
    this.c = new Crawler({
      jQuery: true, // 使用 cheerio (更轻量)
      // maxConnections: 10,
      // rateLimit: 2000, // 由队列控制
      forceUTF8: true,
      timeout: 100000,
      // incomingEncoding: 'utf8', // 根据目标站点调整，如 'gbk'
      callback: async (error, res, done) => {
        if (error) {
          pageEnd.error(`Request failed: ${res?.options?.uri || 'unknown'}`, error);
          done();
          return;
        }

        const { $, options } = res;
        const currentUrl = options.uri;

        try {
          // 获取链接并加入队列
          await this.processLinks($, currentUrl);

          // 处理当前页面内容（提取资源、修改HTML）
          const processedHtml = this.processPageContent($, currentUrl);

          // 生成本地文件
          const outputPath = this.getLocalPath(currentUrl);
          await this.writePage(outputPath, processedHtml);

          pageEnd.info(`Page processed: ${decodeURI(currentUrl)}`);
        } catch (err) {
          pageEnd.error(`Error processing page ${currentUrl}:`, err);
        } finally {
          done();
        }
      },
    });
  }

  /**
   * 处理页面中的链接，发现新页面并加入队列
   * @param {Function} $ - cheerio/jQuery 对象
   * @param {string} currentUrl - 当前页面URL
   */
  async processLinks($, currentUrl) {
    const links = $('a[href]');
    const baseUrl = new URL(currentUrl);

    for (let i = 0; i < links.length; i++) {
      const href = $(links[i]).attr('href');
      if (!href) continue;

      try {
        const url = new URL(href, baseUrl); // 转换为绝对URL
        const absoluteUrl = url.origin + url.pathname;  // new URL(href, baseUrl).href;

        // 判断是否是目标站点且包含中文
        if (
          absoluteUrl.startsWith(this.project) &&
          /[\u4E00-\u9FA5]/.test(decodeURI(absoluteUrl)) &&
          !this.visited.has(absoluteUrl)
        ) {
          this.visited.add(absoluteUrl);
          this.pageSum++;
          // 加入页面抓取队列
          this.pageQueue.add(() => {
            pageStart.info(`Queuing page: ${decodeURI(absoluteUrl)}`);
            this.c.queue(absoluteUrl);
          });
        }
      } catch (e) {
        // 忽略无效的URL
        debug(`Invalid URL: ${href}`);
      }
    }
  }

  /**
   * 处理页面内容：提取资源、修改路径、清理HTML
   * @param {Function} $ - cheerio/jQuery 对象
   * @param {string} currentUrl - 当前页面URL
   * @returns {string} 处理后的HTML
   */
  processPageContent($, currentUrl) {
    const assetTypes = {
      img: ['src', 'data-src', 'data-original', 'lazy-src', 'data-full-url'],
      // 注意：我们不再在这里为 img 包含 'srcset'，因为它需要特殊处理
      link: ['href'], // CSS, icons
      script: ['src'],
      video: ['src'],
      source: ['src'],
      iframe: ['src'],
      audio: ['src']
    };

    // 修正后的正则，允许查询参数
    const ASSET_REGEX = /\.(jpe?g|png|gif|webp|svg|css|js|mp4|webm|ogg|wav|woff2?|ttf|ico|bmp|tiff?|pdf|docx?|xlsx?|pptx?|zip|rar|3gp)(\?.*)?$/i;

    const currentHostname = new URL(currentUrl).hostname;

    for (const [tag, attrs] of Object.entries(assetTypes)) {
      $(tag).each((index, element) => {
        const $el = $(element);
        attrs.forEach(attr => {
          const src = $el.attr(attr);
          if (!src) return;

          try {
            const absoluteUrl = new URL(src, currentUrl).href;
            const urlObj = new URL(absoluteUrl);

            if (urlObj.hostname !== currentHostname) {
              return;
            }

            if (!ASSET_REGEX.test(absoluteUrl)) {
              return;
            }

            const localPath = this.getLocalAssetPath(absoluteUrl);

            if (!this.downloadedAssets.has(absoluteUrl)) {
              this.downloadedAssets.add(absoluteUrl);
              this.downloadImg(absoluteUrl, localPath);
            }

            // const pageDir = path.dirname(this.getLocalPath(currentUrl));
            const dir = path.join(__dirname, '..', 'dist');
            const relativePath = path.relative(dir, localPath).replace(/\\/g, '/');
            $el.attr(attr, `/${relativePath}`);

          } catch (e) {
            debug(`Invalid resource URL: ${src}`, e.message);
          }
        });
      });
    }

    // ✅ 新增：处理内联 <style> 标签中的 url()
    $('style[type="text/css"], style:not([type])').each((index, element) => {
      const $style = $(element);
      const cssText = $style.html(); // 获取 style 标签内的 CSS 文本
      if (!cssText || cssText.trim() === '') return;

      // 用于存储需要替换的 [原始匹配字符串, 新的url字符串] 对
      const replacements = [];

      try {
        // 1. 使用 matchAll 获取所有匹配
        // 注意：使用 g 标志，matchAll 会返回一个迭代器
        const URL_REGEX = /url\(\s*['"]?([^'")]+?)['"]?\s*\)/gi;

        // ✅ 使用 for...of 遍历 matchAll 的结果
        for (const match of cssText.matchAll(URL_REGEX)) {
          const fullMatch = match[0];        // 整个匹配，如 url("https://...")
          const urlInCss = match[1];         // 括号内捕获组，即 URL 本身
          if (!urlInCss) continue;

          try {
            // 2. 将 CSS 中的相对路径转换为绝对 URL
            const absoluteUrl = new URL(urlInCss, currentUrl).href;
            const urlObj = new URL(absoluteUrl);

            // 3. 检查是否同域且是资源文件
            if (urlObj.hostname !== currentHostname) {
              continue; // 跳过外部资源
            }

            if (!ASSET_REGEX.test(absoluteUrl)) {
              continue; // 不是目标资源类型
            }

            // 4. 下载资源
            const localPath = this.getLocalAssetPath(absoluteUrl);
            if (!this.downloadedAssets.has(absoluteUrl)) {
              this.downloadedAssets.add(absoluteUrl);
              this.downloadImg(absoluteUrl, localPath); // 入队下载
            }

            // 5. 计算本地相对路径 (相对于当前 HTML 文件)
            // const pageDir = path.dirname(this.getLocalPath(currentUrl));
            const dir = path.join(__dirname, '..', 'dist');
            const relativePath = path.relative(dir, localPath).replace(/\\/g, '/');

            // 6. 构造新的 url(...) 字符串，尽量保持原有格式
            let newUrlStr;
            if (fullMatch.startsWith('url("') && fullMatch.endsWith('")')) {
              newUrlStr = `url("/${relativePath}")`;
            } else if (fullMatch.startsWith("url('") && fullMatch.endsWith("')")) {
              newUrlStr = `url('/${relativePath}')`;
            } else {
              // 无引号或其它情况
              newUrlStr = `url(/${relativePath})`;
            }

            // 7. 记录替换对
            replacements.push({
              original: fullMatch,
              replacement: newUrlStr
            });

          } catch (urlError) {
            debug(`Invalid URL in CSS: ${urlInCss}`, urlError.message);
          }
        }

        // 8. 执行所有替换
        // ✅ 关键：在收集完所有替换项后，再统一进行字符串替换
        // 这样就不会干扰 matchAll 的迭代
        let newCssText = cssText;
        for (const { original, replacement } of replacements) {
          // 注意：这里只替换第一次出现的 original
          // 如果同一个 URL 出现多次，需要循环替换或使用全局替换
          newCssText = newCssText.replace(original, replacement);
        }

        // 9. 更新 <style> 标签内容
        if (newCssText !== cssText) {
          $style.html(newCssText);
        }

      } catch (e) {
        debug(`Error processing inline CSS: ${cssText}`, e.message);
        // 可以选择保留原始 CSS
      }
    });

    // 移除或清理脚本内容
    $('script').each((i, el) => {
      const $script = $(el);
      const src = $script.attr('src');
      if (!src) {
        $script.text(''); // 清空内联脚本
      }
    });

    // 删除 srcset 属性
    $('[srcset]').removeAttr('srcset');

    // 删除多余信息
    $('link[rel!="stylesheet"]').remove();
    $('meta[name="msapplication-TileImage"]').remove();
    $('#blossom-feminine-google-fonts-css').remove();
    $('#colophon').remove();

    // 替换敏感词（示例）
    const html = $.html();
    return html
      .replace(/http(s)?:/g, '')
      .replace(/(\/\/)?lXsW(\d)+(\.com)?/gi, '');
  }

  /**
   * 下载图片/资源
   * @param {string} imgUrl - 资源URL
   * @param {string} fileName - 本地文件路径
   */
  downloadImg(imgUrl, fileName) {
    this.assetQueue.add(() => this.downloadWithRetry(imgUrl, fileName));
  }

  /**
     * 获取资源的本地存储路径 - 保留原始文件名
     * @param {string} url - 资源URL
     * @returns {string} 本地文件路径
     */
  getLocalAssetPath(url) {
    try {
      const parsedUrl = new URL(url);
      let { pathname } = parsedUrl;

      // 处理根路径或空路径
      if (pathname === '/' || pathname === '') {
        pathname = '/index';
      }

      // 移除可能的查询参数（?v=1.0 等）
      const cleanPathname = pathname.split('?')[0];

      // 解码URL编码的路径名（非常重要！）
      // 例如: %E4%B8%AD%E6%96%87.jpg -> 中文.jpg
      const decodedPathname = decodeURIComponent(cleanPathname);

      // 构建基于项目域名的目录结构
      // 例如: https://lxsw2020.com/images/photo.jpg
      //      -> dist/images/photo.jpg
      // const hostnameDir = parsedUrl.hostname.replace(/[:.]/g, '_'); // 处理端口和点
      // const dir = path.join(__dirname, '..', 'dist', 'assets', hostnameDir);
      const dir = path.join(__dirname, '..', 'dist');

      // 使用解码后的路径作为文件的相对路径
      // path.join 会处理跨平台路径分隔符
      return path.join(dir, decodedPathname);
    } catch (e) {
      // 解析失败时的备选方案
      console.error(`Failed to parse URL for local path: ${url}`, e);
      const ext = path.extname(url) || '.bin';
      return path.join(__dirname, '..', 'dist', 'assets', 'fallback', `unknown_${Date.now()}${ext}`);
    }
  }

  /**
   * 带重试机制的资源下载 - 增加存在性检查
   * @param {string} imgUrl - 资源URL
   * @param {string} fileName - 本地文件路径 (由 getLocalAssetPath 生成)
   */
  async downloadWithRetry(imgUrl, fileName) {
    const maxRetries = 3;

    // ✅ 关键修改：检查文件是否已存在
    if (fs.existsSync(fileName)) {
      assetsEnd.info(`File already exists, skipping download: ${fileName}`);
      this.downloadNum++; // 如果您希望将“跳过”也算作“完成”，则计数
      return; // 直接返回，不进行下载
    }

    // 确保目录存在
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
          const options = {
            url: imgUrl,
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36',
              'Referer': getHiddenUrl(), // 根据实际网站改
              // 如需Cookie也可加：'Cookie': 'xxx'
            },
            timeout: 20000
          };
          const requestStream = request.get(options); // request.get(encodeURI(imgUrl)); // 对URL编码

          requestStream.on('error', reject);
          writeStream.on('error', (err) => {
            // 下载出错时，删除可能已创建的不完整文件
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
        return; // 成功下载，退出
      } catch (error) {
        const delay = 2000 * Math.pow(2, i); // 指数退避
        assetsEnd.warn(`Download failed (${i + 1}/${maxRetries}): ${decodeURI(imgUrl)}, retrying in ${delay}ms. Error:`, error.message);

        if (i === maxRetries - 1) {
          assetsEnd.error(`Download ultimately failed: ${decodeURI(imgUrl)}`);
          // 可以选择在这里创建一个空文件或占位符，标记此资源下载失败，避免下次重试
          // 例如: fs.writeFileSync(fileName + '.FAILED', 'Download failed');
          break;
        }

        await new Promise(r => setTimeout(r, delay));
      }
    }
  }

  /**
   * 获取页面的本地存储路径
   * @param {string} url - 页面URL
   * @returns {string} 本地目录路径
   */
  getLocalPath(url) {
    try {
      const parsedUrl = new URL(url);
      let { pathname } = parsedUrl;

      // 处理根路径
      if (pathname === '/' || pathname === '') {
        pathname = '/index';
      }

      // 确保以斜杠开头
      if (!pathname.startsWith('/')) {
        pathname = `/${pathname}`;
      }

      // 解码路径名
      const decodedPath = decodeURI(pathname);
      return path.join(__dirname, '..', 'dist', decodedPath);
    } catch (e) {
      // 失败时使用默认路径
      return path.join(__dirname, '..', 'dist', 'pages', 'unknown');
    }
  }

  /**
   * 写入页面文件
   * @param {string} filepath - 输出目录
   * @param {string} htmlContent - HTML内容
   */
  async writePage(filepath, htmlContent) {
    return new Promise((resolve, reject) => {
      mkdirp(filepath, (err) => {
        if (err) {
          console.error('Failed to create directory:', err);
          reject(err);
          return;
        }

        const content = `${htmlContent}`;

        const filePath = path.join(filepath, 'index.html');
        fs.writeFile(filePath, content, 'utf8', (e) => {
          if (e) {
            console.error('Failed to write file:', e);
            reject(e);
          } else {
            debug("Page saved!");
            console.log('>>> 页面生成成功！', filepath);
            resolve();
          }
        });
      });
    });
  }
}

// 获取小网站地址
function getHiddenUrl() {
  const encodedPath = atob('Ly9seHN3MjAyMC5jb20v');
  const protocol = '\u0068\u0074\u0074\u0070\u0073';
  return `${protocol}:${encodedPath}`;
}

// ==================== 启动爬虫 ====================
function startCrawler() {
  const url = getHiddenUrl()
  const core = new Core(url);
  core.start();
  // 可选：监听队列完成事件
  core.pageQueue.onEmpty().then(() => {
    console.log('=== 所有页面抓取任务已完成 ===');
    console.log(`抓取页面数: ${core.pageSum}`);
    console.log(`下载资源数: ${core.downloadNum}`);
  });

  core.assetQueue.onIdle().then(() => {
    console.log('=== 所有资源下载任务已完成 ===');
  });
}
