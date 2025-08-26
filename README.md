# 抓笔趣阁小说

笔趣阁小说网站：https://www.c9bfbcdc82.sbs

# 替换小说目录
```
  const ENTRY_URL = 'https://www.c9bfbcdc82.sbs/book/182355/'; // 可改成你的目录页
```
# 抓取
`yarn build`

# 傻瓜式教程
- 下载、安装node 

  通过网盘分享的文件：node-v18.20.3-x64.msi

  链接: https://pan.baidu.com/s/1JKw_zgyDawH0lNYfR8JuvQ?pwd=2wwm 提取码: 2wwm 复制这段内容后打开百度网盘手机App，操作更方便哦

  下载msi文件，双击运行，等待结束即可。

- 安装yarn

  安装成功nodejs之后，直接在当前项目的根目录下右键鼠标打开菜单，(根目录就是双击打开这个项目，能看到src这个文件夹就对了)，在菜单中选择：在终端打开，或者选择：在此处打开powershell窗口，这个要看操作系统

  在cmd或者powershell的界面，输入命令：`npm install yarn`，回车就会进入安装yarn的流程，等待结束即可。

- 安装yarn的依赖

  接上一步，输入命令：`yarn`，然后回车，就会进入安装yarn依赖的流程，等待结束即可。

- 替换小说目录

  打开/src/index.js这个文件，找到`const ENTRY_URL = "xxxx"`这行，把你想要下载的小说地址的目录页复制过来，替换xxxx，保存。
  
  注意，这里只能下载笔趣阁的小说，而且要确保从目录页点进去的章节页面，网站地址的www.xxx.xxx/这部分和目录页一致，否则请用章节页的这部分替换目录页的这部分。

  比如：

  目录页: https://www.bqgda.cc/books/136187/

  章节页：https://www.c9bfbcdc82.sbs/book/182355/1.html

  很显然地址被替换了，所以应该把目录页替换为：https://www.c9bfbcdc82.sbs/book/182355/

- 开始抓取小说

  接上一步，输入命令：`yarn build`，即可开始下载，能看到下载进度：`完成：1/xxxx`，等待下载完成即可。

  会在根目录下，生成一个文件夹bqg，bqg文件夹下，就是小说，会不断往这里写入小说内容。
