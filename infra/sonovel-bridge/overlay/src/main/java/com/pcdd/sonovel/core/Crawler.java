package com.pcdd.sonovel.core;

import cn.hutool.core.collection.CollUtil;
import cn.hutool.core.date.StopWatch;
import cn.hutool.core.io.FileUtil;
import cn.hutool.core.lang.Console;
import cn.hutool.core.util.NumberUtil;
import cn.hutool.core.util.StrUtil;
import cn.hutool.json.JSONUtil;
import com.pcdd.sonovel.context.BookContext;
import com.pcdd.sonovel.handle.CrawlerPostHandler;
import com.pcdd.sonovel.model.AppConfig;
import com.pcdd.sonovel.model.Chapter;
import com.pcdd.sonovel.model.Rule.Book;
import com.pcdd.sonovel.parse.BookParser;
import com.pcdd.sonovel.parse.ChapterParser;
import com.pcdd.sonovel.parse.TocParser;
import com.pcdd.sonovel.util.FileUtils;
import com.pcdd.sonovel.util.LogUtils;
import com.pcdd.sonovel.util.VirtualThreadLimiter;
import com.pcdd.sonovel.web.model.DownloadProgressInfo;
import com.pcdd.sonovel.web.servlet.DownloadProgressSseServlet;
import lombok.SneakyThrows;
import me.tongfei.progressbar.ProgressBar;

import java.io.BufferedOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;

import static org.fusesource.jansi.AnsiRenderer.render;

/**
 * Bridge-compatible Crawler variant that exposes the generated artifact and task progress.
 */
public class Crawler {

    private final AppConfig config;
    private final String taskId;
    private int digitCount;
    private String bookDir;
    private File lastOutputFile;
    private Book lastBook;
    private int lastChapterCount;

    public Crawler(AppConfig config) {
        this(config, "");
    }

    public Crawler(AppConfig config, String taskId) {
        this.config = config;
        this.taskId = taskId == null ? "" : taskId;
    }

    public File getLastOutputFile() {
        return lastOutputFile;
    }

    public Book getLastBook() {
        return lastBook;
    }

    public int getLastChapterCount() {
        return lastChapterCount;
    }

    public double crawl(String bookUrl) {
        TocParser tocParser = new TocParser(config);
        List<Chapter> toc = tocParser.parseAll(bookUrl);
        if (CollUtil.isEmpty(toc)) {
            Console.error("<== 源站章节目录为空，中止下载");
            return 0;
        }
        Console.log("<== 共计 {} 章", toc.size());
        return crawl(bookUrl, toc);
    }

    @SneakyThrows
    public double crawl(String bookUrl, List<Chapter> toc) {
        digitCount = String.valueOf(toc.size()).length();
        Book book = new BookParser(config).parse(bookUrl);
        BookContext.set(book);
        lastBook = book;
        lastChapterCount = toc.size();
        lastOutputFile = null;

        bookDir = FileUtils.sanitizeFileName(
                "%s (%s) %s".formatted(book.getBookName(), book.getAuthor(), config.getExtName().toUpperCase()));
        File dir = FileUtil.mkdir(new File(config.getDownloadPath() + File.separator + bookDir));
        if (!dir.exists()) {
            Console.log(render("""
                    创建下载目录失败：%s
                    1. 检查 config.ini 下载路径是否合法
                    2. 尝试以管理员身份运行（部分目录需要管理员权限）
                    """.formatted(dir), "red"));
            return 0;
        }

        if (config.getConcurrency() > 100) {
            config.setConcurrency(100);
        }

        int maxConcurrent = config.getConcurrency() == -1
                ? Math.min(50, toc.size())
                : Math.min(config.getConcurrency(), toc.size());

        LogUtils.infoConsole("开始下载:《{}》({}) 共计 {} 章 | 最大并发 {}",
                book.getBookName(), book.getAuthor(), toc.size(), maxConcurrent);

        StopWatch stopWatch = new StopWatch();
        stopWatch.start();
        ChapterParser chapterParser = new ChapterParser(config);
        ProgressBar progressBar = null;

        if (config.getEnableProgressbar() == 1) {
            try {
                progressBar = ProgressBar.builder()
                        .setTaskName("Downloading...")
                        .setInitialMax(toc.size())
                        .setMaxRenderedLength(100)
                        .setUpdateIntervalMillis(100)
                        .showSpeed()
                        .build();
            } catch (Exception e) {
                Console.error("下载进度条初始化失败，已切换为静默下载");
            }
        }

        ProgressBar finalProgressBar = progressBar;
        AtomicInteger completed = new AtomicInteger(0);

        try (var limiter = new VirtualThreadLimiter(maxConcurrent)) {
            toc.forEach(item -> limiter.submit(() -> {
                createChapterFile(chapterParser.parse(item));

                long currentIndex = completed.incrementAndGet();
                if (finalProgressBar != null) {
                    finalProgressBar.stepTo(currentIndex);
                }

                if (config.getWebEnabled() == 1 && (currentIndex % 50 == 0 || currentIndex == toc.size())) {
                    DownloadProgressSseServlet.sendProgress(JSONUtil.toJsonStr(DownloadProgressInfo.builder()
                            .type("download-progress")
                            .taskId(taskId)
                            .index(currentIndex)
                            .total(toc.size())
                            .build()));
                }
            }));
        }

        if (progressBar != null) {
            progressBar.close();
        }
        LogUtils.info("-".repeat(100));
        Console.log("<== 章节下载日志已保存至 {}，请检查是否有 [ERROR] 级别的日志。",
                LogUtils.getLogFile().getAbsolutePath());

        new CrawlerPostHandler(config).handle(dir);
        lastOutputFile = resolveOutputFile(book);
        stopWatch.stop();
        BookContext.clear();

        double totalTimeSeconds = stopWatch.getTotalTimeSeconds();
        Console.log(render("<== 完成！总耗时 {} s\n", "green"), NumberUtil.round(totalTimeSeconds, 2));
        return totalTimeSeconds;
    }

    private File resolveOutputFile(Book book) {
        String extName = config.getExtName().toLowerCase();
        String fileName = switch (extName) {
            case "txt", "epub" -> "%s(%s).%s".formatted(book.getBookName(), book.getAuthor(), extName);
            case "html", "pdf" -> "%s(%s) %s.%s".formatted(book.getBookName(), book.getAuthor(), extName.toUpperCase(), extName);
            default -> "";
        };
        if (fileName.isEmpty()) {
            return null;
        }
        return new File(FileUtils.toAbsolutePath(config.getDownloadPath() + File.separator + fileName));
    }

    private void createChapterFile(Chapter chapter) {
        if (chapter == null) return;

        try (OutputStream fos = new BufferedOutputStream(new FileOutputStream(generateChapterPath(chapter)))) {
            fos.write(chapter.getContent().getBytes(StandardCharsets.UTF_8));
        } catch (Exception e) {
            Console.error(e);
        }
    }

    private String generateChapterPath(Chapter chapter) {
        String parentPath = config.getDownloadPath() + File.separator + bookDir + File.separator;
        String order = digitCount >= String.valueOf(chapter.getOrder()).length()
                ? StrUtil.padPre(chapter.getOrder() + "", digitCount, '0')
                : String.valueOf(chapter.getOrder());

        return parentPath + order + switch (config.getExtName()) {
            case "html" -> "_.html";
            case "txt" -> "_" + FileUtils.sanitizeFileName(chapter.getTitle()) + ".txt";
            case "epub", "pdf" -> "_" + FileUtils.sanitizeFileName(chapter.getTitle()) + ".html";
            default -> throw new IllegalStateException("暂不支持的下载格式: " + config.getExtName());
        };
    }

}
