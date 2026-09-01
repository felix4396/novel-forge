package com.pcdd.sonovel.web.servlet;

import cn.hutool.core.bean.BeanUtil;
import cn.hutool.core.lang.Console;
import cn.hutool.core.util.StrUtil;
import com.pcdd.sonovel.core.AppConfigLoader;
import com.pcdd.sonovel.core.Crawler;
import com.pcdd.sonovel.model.AppConfig;
import com.pcdd.sonovel.model.SearchResult;
import com.pcdd.sonovel.util.SourceUtils;
import com.pcdd.sonovel.web.util.RespUtils;
import com.pcdd.sonovel.web.BridgeSourcePolicy;
import com.pcdd.sonovel.web.BridgeWorkCoordinator;
import jakarta.servlet.http.HttpServlet;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;

import java.util.Set;
import java.util.LinkedHashMap;
import java.util.Map;

public class BookFetchServlet extends HttpServlet {

    private static final Set<String> ALLOWED_FORMATS = Set.of("epub", "txt", "html", "pdf");
    private static final Set<String> ALLOWED_LANGUAGES = Set.of("zh-cn", "zh-tw", "zh-hant");

    @Override
    protected void doGet(HttpServletRequest req, HttpServletResponse resp) {
        try {
            String bookUrl = req.getParameter("url");
            String format = req.getParameter("format");
            String language = req.getParameter("language");
            String concurrencyStr = req.getParameter("concurrency");
            String taskId = req.getParameter("taskId");
            int id = SourceUtils.getRule(bookUrl).getId();
            if (BridgeSourcePolicy.isDisabled(id)) {
                RespUtils.writeError(resp, 403, "该书源已被禁用");
                return;
            }

            if (StrUtil.isNotBlank(format) && !ALLOWED_FORMATS.contains(format.toLowerCase())) {
                RespUtils.writeError(resp, 400, "不支持的下载格式: " + format + "，可选R: epub, txt, html, pdf");
                return;
            }

            if (StrUtil.isNotBlank(language) && !ALLOWED_LANGUAGES.contains(language.toLowerCase())) {
                RespUtils.writeError(resp, 400, "不支持的语言: " + language + "，可选: zh-CN, zh-TW, zh-Hant");
                return;
            }

            Integer concurrency = null;
            if (StrUtil.isNotBlank(concurrencyStr)) {
                concurrency = Integer.parseInt(concurrencyStr);
                int configConcurrency = AppConfigLoader.APP_CONFIG.getConcurrency();
                int maxAllowed = configConcurrency > 0 ? configConcurrency : 50;
                if (concurrency < 1 || concurrency > maxAllowed) {
                    RespUtils.writeError(resp, 400, "并发数须在 1~" + maxAllowed + " 之间");
                    return;
                }
            }

            SearchResult sr = SearchResult.builder()
                    .sourceId(id)
                    .url(bookUrl)
                    .build();

            Integer selectedConcurrency = concurrency;
            DownloadResult result = BridgeWorkCoordinator.runDownload(
                    () -> downloadFileToServer(sr, format, language, selectedConcurrency, taskId));
            if (result.totalTimeSeconds() == 0) {
                RespUtils.writeError(resp, 500, "源站章节目录为空，中止下载");
                return;
            }
            if (result.crawler().getLastOutputFile() == null || !result.crawler().getLastOutputFile().isFile()) {
                RespUtils.writeError(resp, 500, "EPUB 文件生成失败");
                return;
            }
            Map<String, Object> data = new LinkedHashMap<>();
            data.put("taskId", taskId == null ? "" : taskId);
            data.put("fileName", result.crawler().getLastOutputFile().getName());
            data.put("bookName", result.crawler().getLastBook().getBookName());
            data.put("author", result.crawler().getLastBook().getAuthor());
            data.put("elapsedSeconds", result.totalTimeSeconds());
            RespUtils.writeJson(resp, data);

        } catch (Exception e) {
            RespUtils.writeError(resp, 500, e.getMessage());
        }
    }

    private DownloadResult downloadFileToServer(SearchResult sr, String format, String language, Integer concurrency, String taskId) {
        AppConfig cfg = BeanUtil.copyProperties(AppConfigLoader.APP_CONFIG, AppConfig.class);
        cfg.setSourceId(sr.getSourceId());

        if (StrUtil.isNotBlank(format)) {
            cfg.setExtName(format.toLowerCase());
        }
        if (StrUtil.isNotBlank(language)) {
            cfg.setLanguage(language);
        }
        if (concurrency != null) {
            cfg.setConcurrency(concurrency);
        }

        Console.log("<== 正在解析章节目录...");

        Crawler crawler = new Crawler(cfg, taskId);
        return new DownloadResult(crawler.crawl(sr.getUrl()), crawler);
    }

    private record DownloadResult(double totalTimeSeconds, Crawler crawler) {
    }

}
