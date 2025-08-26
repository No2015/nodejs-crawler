const axios = require('axios');
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');
const mkdirp = require('mkdirp');

const ENTRY_URL = 'https://www.c9bfbcdc82.sbs/book/182355/';
const OUTPUT_DIR = path.join(__dirname, '../bqg');
const RETRY = 3;

// 表示从第1章开始
const startIndex = 1; // 1-based
const START_INDEX = Math.max(startIndex - 1, 0); // 转为0-based

async function fetchWithRetry(url, tries = RETRY) {
  for (let i = 0; i < tries; i++) {
    try {
      return await axios.get(url, { timeout: 20000 });
    } catch (err) {
      if (i === tries - 1) throw err;
      await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
  }
}

(async () => {
  try {
    // 1. 获取目录页
    const entryResp = await fetchWithRetry(ENTRY_URL);
    const entryDom = new JSDOM(entryResp.data);
    const { document } = entryDom.window;

    // 2. 小说名称
    let title = document.querySelector('.book h1')?.textContent?.trim();
    if (!title) {
      title =
        document.querySelector('title')?.textContent?.split(/[(_（]/)[0].trim() ||
        document.querySelector('.listmain dt')?.textContent?.trim() ||
        '未命名小说';
    }

    // 3. 章节列表
    const catalog = document.querySelector('.listmain');
    if (!catalog) {
      console.error('目录(class="listmain")未找到！');
      return;
    }
    const chapterNodes = Array.from(catalog.querySelectorAll('dd a'));
    if (!chapterNodes.length) {
      console.error('未找到任何章节链接！');
      return;
    }

    // 4. 创建输出文件
    await mkdirp(OUTPUT_DIR);
    const outPath = path.join(OUTPUT_DIR, `${title}.txt`);
    // 如果不是从头开始，文件必须已存在且追加写入，否则新建
    const outStream = fs.createWriteStream(outPath, {
      flags: START_INDEX === 0 ? 'w' : 'a',
      encoding: 'utf8'
    });

    if (START_INDEX >= chapterNodes.length) {
      console.log('指定起始章节超过总章节数，无需处理。');
      outStream.end();
      return;
    }

    console.log(
      `开始抓取《${title}》，共${chapterNodes.length}章...将从第${START_INDEX + 1}章(${chapterNodes[START_INDEX].textContent.trim()})开始`
    );

    // 5. 逐章抓取
    for (let i = START_INDEX; i < chapterNodes.length; i++) {
      const node = chapterNodes[i];
      const chapterTitle = node.textContent.trim();
      const chapterUrl = new URL(node.getAttribute('href'), ENTRY_URL).href;

      try {
        const chapResp = await fetchWithRetry(chapterUrl);
        const chapDom = new JSDOM(chapResp.data);
        const chapDoc = chapDom.window.document;

        const contentNode = chapDoc.querySelector('#chaptercontent');
        let content = '';
        if (contentNode) {
          // 清除 <p class="readinline"> ... </p>
          contentNode.querySelectorAll('p.readinline').forEach(e => e.remove());
          // <br> 替换为换行
          let html = contentNode.innerHTML
            .replace(/<br\s*\/?>/gi, '\n')
            .replace(/&nbsp;/gi, ' ');

          // 过滤广告标语等
          html = html.replace(/请收藏本站.*?。/g, '');

          // 去除多余空行
          content = html.replace(/\n{3,}/g, '\n\n').trim();

          // 判断开头是否有章节标题
          // 允许前面有空白、全角空格
          // 只要章节标题在正文开头20个字符内都算“已包含”
          const normalized = content.replace(/^[\s\u3000]+/, ''); // 去掉开头空白、全角空格
          if (normalized.slice(0, 20).includes(chapterTitle)) {
            // 已含标题，不加
            // nothing to do
          } else {
            content = `${chapterTitle}\n\n${content}`;
          }
        } else {
          content = `${chapterTitle}\n\n【正文获取失败】`;
        }

        outStream.write(`${content}\n\n`);
        console.log(`完成：${chapterTitle}: ${i + 1}/${chapterNodes.length}`);
        await new Promise(r => setTimeout(r, 800));
      } catch (err) {
        console.error('章节抓取失败：', chapterUrl, err.message);
        outStream.write(`【抓取失败】\n\n`);
      }
    }

    outStream.end();
    console.log('全部章节已抓取完毕，文件保存在：', outPath);
  } catch (err) {
    console.error('主流程异常:', err.message);
  }
})();