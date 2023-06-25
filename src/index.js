const fs = require('fs');
const Crawler = require('crawler');
const jsdom = require('jsdom');
const path = require('path');
const request = require('request');
const mkdirp = require('mkdirp');
const debug = require('debug')('crawler');

var log4js = require('log4js');

log4js.configure({
	"appenders":{
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
        cheese: { appenders: ['pageEnd'], level: 'error' },
        another: { appenders: ['console'], level: 'trace' },
        default: { appenders: ['console', 'pageStart'], level: 'trace' },
        pageEnd: { appenders: ['console', 'pageEnd'], level: 'trace' },
        pageStart: { appenders: ['console', 'pageStart'], level: 'trace' },
        assetsStart: { appenders: ['console', 'assetsStart'], level: 'trace' },
        assetsEnd: { appenders: ['console', 'assetsEnd'], level: 'trace' },
    }
})
var pageStart = log4js.getLogger('pageStart')
var pageEnd = log4js.getLogger('pageEnd')
var assetsStart = log4js.getLogger('assetsStart')
var assetsEnd = log4js.getLogger('assetsEnd')


class Core {
    constructor(hostUrl) {
        this.c = null
        this.host = hostUrl
        this.pageId = ''
        this.pageSum = 0
        this.srcs = []
        this.currentPage = {
            title: '',
            chapters: []
        }
        this.downloadNum = 0
    }
    start(pageId) {
        this.pageId = pageId
        this.initCrawler();

        // 章节列表
        this.c.queue(this.host + this.pageId);
    }
    initCrawler() {
        this.c = new Crawler({
            jQuery: jsdom,
            // maxConnections: 10,
            rateLimit: 2e3,
            forceUTF8: true,
            timeout: 1e5,
            // incomingEncoding: 'gb2312',
            // method: 'GET',
            // strictSSL: true,
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36',
            // This will be called for each crawled page
            callback: (error, res, done) => {
                if (error) {
                    pageEnd.error(error)
                } else {
                    const { $ } = res;

                    // 获取详情页------------------------- start
                    const urls = $('#list a');

                    this.getUrls($, urls)
                    // 获取详情页------------------------- end
                    
                    // 生成首页内容-------------------- start
                    let html = $('body').html()
                    
                    const content = this.formatContent(html);
                    const page = 'index.html'
            
                    this.writePage('../'+this.pageId, page, content);
                    // 生成首页内容-------------------- end
                }
                done();
            },
        });
      
    }
    
    getUrls($, urls) {
        for (let i = 0; i < urls.length; i++) {
            const $url = $(urls[i]);
            const name = decodeURI($url.html())
            const url = this.host + $url.attr('href') + '';
            const urlArr = url.split('/')
            const page = decodeURI(urlArr[urlArr.length-1])
            const isLoaded = false
            if (!this.currentPage.chapters.find(el => el.url === url)) {
                this.currentPage.chapters.push({name, url, page, isLoaded});
            }
        }
        for (let i = 0; i < this.currentPage.chapters.length; i++) {
            const item = this.currentPage.chapters[i]
            if (!item.isLoaded) {
                this.pageSum ++
                item.isLoaded = true
                this.getOneChapter(item);
            }
        }
        console.log('>>>pageSum ', this.pageSum)
    }
    downloadImg(imgUrl, fileName) {

        const dirName = fileName.match(/(.*)\//)[1]
        
        if(!fs.existsSync(dirName)) {
            this.mkdirsSync(dirName)
        }
        assetsStart.info(decodeURI(imgUrl))
        this.download(imgUrl, fileName)
    }
    download(imgUrl, fileName) {
        const downloadStream = request(encodeURI(imgUrl))
        downloadStream.pipe(fs.createWriteStream(fileName)).on('close', () => {
            assetsEnd.info(decodeURI(imgUrl))
        })
        downloadStream.on('error', e => {
            assetsEnd.error(`下载图片 ${decodeURI(imgUrl)} 出错,准备重试`, JSON.stringify(e))
            if (e.code === 'ETIMEDOUT') {
                this.download(imgUrl, fileName)
            }
        })
    }
    
    mkdirsSync(dirName) {
        if(fs.existsSync(dirName)) {
            return true;
        } else {
            if(this.mkdirsSync(path.dirname(dirName))) {
                fs.mkdirSync(dirName);
                return true;
            }
        }
    }
    formatContent(html) {
        const srcs = []
        html = html.replace(/(?<!:)(\/\/www)/g,'http:$1')

        // 读取资源文件，更换资源文件地址
        const replaceList = [/http(s)?[^\"]*jp(e)?g/g, /http(s)?[^\"]*mp4/g, /http(s)?[^\"]*css/g, /http(s)?[^\"]*png/g, /http(s)?[^\"]*svg/g]
        replaceList.forEach(rex => {
            html = html.replace(rex, src => {
                src.split(' ').forEach(s => {
                    if (s.match('http')) {
                        srcs.push(s.replace(/\\/g, ''))
                    }
                })
                return src.replace(/http[^"]*(com|org)\//g, '')
            })
        })

        // 删除脚本文件，屏蔽脚本内容
        html = html.replace(/\<script.*script\>/g, '')
        html = html.replace(/script/g, 'noscript')
        html = html.replace(/http(s)?:\/\/[^"\s]*/g, s => {
            if (s.match(this.host)) {
                return s
            } else {
                return ''
            }
        })

        // 下载资源
        let time = 0
        for (let i = 0; i < srcs.length; i++) {
            const src = srcs[i]
            const fileName = src.replace(/(.*\/)/g, '')
            const _src = src.replace(/http[^"]*(com|org)/g, path.resolve(__dirname, '../../' + this.pageId))
            if (fileName.match(/\./)) {
                if(!fs.existsSync(_src) && !this.srcs.find(s => s === src)) {
                    this.srcs.push(src)
                    time ++
                    const timeout = time * 1e3
                    setTimeout(() => {
                        this.downloadImg(src, _src) 
                    }, timeout);
                }
            }
        }

        // 更换超链接地址
        html = html.replace(/&nbsp;/g, '');
        html = html.replace(/(")(http(s)?:\/\/[^"]*)(")/g, s => {
            const href = decodeURI(s)
            if (href.match(/[\u4E00-\u9FA5]/g)) {
                return href.replace(this.host, this.pageId)
            } else {
                return `""`
            }
        })
        
        return html
    }
    writePage(filepath, page, res) {
        mkdirp(filepath, (err) => {
            if (err) {
                console.error(err);
            } else {
                debug('pow!');
            }
        
            const content = `<!DOCTYPE html>
            <html lang="zh-CN">
            <head>
            <meta http-equiv="Content-Type" content="text/html; charset=utf-8">
            <link rel="stylesheet" type="text/css" href="images/biquge.css">
            </head>
            <body>
            ${res}
            </body>
            </html>`;
        
            fs.writeFile(`${filepath}/${page}`, content, (e) => {
                if (e) {
                    throw e;
                }
            
                debug("It's saved!");
                console.log('>>>页面生成成功！', filepath);
            });
        });
    }
    getOneChapter(chapter) {
        pageStart.info(decodeURI(chapter.url))
        // 分页
        this.c.queue({
            uri: chapter.url,
            jQuery: jsdom,
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36',
            // This will be called for each crawled page
            callback: (error, res, done) => {
                pageEnd.info(decodeURI(chapter.url))
                if (error) {
                    pageEnd.error(error)
                }
                else {
                    const { $ } = res;
                    let html = $('body').html()
                    
                    // 获取详情页------------------------- start
                    // const urls = $('a');

                    // this.getUrls($, urls)
                    // 获取详情页------------------------- end

                    const content = this.formatContent(html);
                    const dirName = `../${this.pageId}`
                    const page = `${chapter.page}`

                    this.writePage(dirName, page, content);
                }
                done();
            },
        });
    }
}

const core = new Core('http://www.ibiqu.org/')
core.start('52_52542')