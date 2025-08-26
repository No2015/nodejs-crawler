const axios = require('axios');
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');
const mkdirp = require('mkdirp');

const ENTRY_URL = 'https://www.c9bfbcdc82.sbs/book/182355/'; // 可改成你的目录页
const OUTPUT_DIR = path.join(__dirname, '../bqg');
const RETRY = 3;

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
    const outStream = fs.createWriteStream(outPath, { flags: 'w', encoding: 'utf8' });

    console.log(`开始抓取《${title}》，共${chapterNodes.length}章...`);

    // 5. 逐章抓取
    for (let i = 0; i < chapterNodes.length; i++) {
      const node = chapterNodes[i];
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
          // 用 <br> 替换为换行
          let html = contentNode.innerHTML
            .replace(/<br\s*\/?>/gi, '\n')
            .replace(/&nbsp;/gi, ' ');

          // 过滤广告标语等
          html = html.replace(/请收藏本站.*?。/g, '');

          // 去除多余空行
          content = html.replace(/\n{3,}/g, '\n\n').trim();
        } else {
          content = '【正文获取失败】';
        }

        outStream.write(`${content}\n\n`);
        console.log(`完成：${i + 1}/${chapterNodes.length}`);
        await new Promise(r => setTimeout(r, 800)); // 防ban
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