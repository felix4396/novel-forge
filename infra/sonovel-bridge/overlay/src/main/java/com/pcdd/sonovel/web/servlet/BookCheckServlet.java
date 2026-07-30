package com.pcdd.sonovel.web.servlet;

import cn.hutool.core.bean.BeanUtil;
import cn.hutool.core.util.StrUtil;
import com.pcdd.sonovel.core.AppConfigLoader;
import com.pcdd.sonovel.context.BookContext;
import com.pcdd.sonovel.model.AppConfig;
import com.pcdd.sonovel.model.Chapter;
import com.pcdd.sonovel.model.Rule.Book;
import com.pcdd.sonovel.parser.BookParser;
import com.pcdd.sonovel.parser.ChapterParser;
import com.pcdd.sonovel.parser.TocParser;
import com.pcdd.sonovel.utils.SourceUtils;
import com.pcdd.sonovel.web.BridgeSourcePolicy;
import com.pcdd.sonovel.web.BridgeWorkCoordinator;
import com.pcdd.sonovel.web.util.RespUtils;
import jakarta.servlet.http.HttpServlet;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

public class BookCheckServlet extends HttpServlet {

    @Override
    protected void doGet(HttpServletRequest req, HttpServletResponse resp) {
        String bookUrl = req.getParameter("url");
        if (StrUtil.isBlank(bookUrl)) {
            RespUtils.writeError(resp, 400, "url 参数不能为空");
            return;
        }

        try {
            int sourceId = SourceUtils.getRule(bookUrl).getId();
            if (BridgeSourcePolicy.isDisabled(sourceId)) {
                RespUtils.writeError(resp, 403, "该书源已被禁用");
                return;
            }

            Map<String, Object> result = new LinkedHashMap<>();
            BridgeWorkCoordinator.runCheck(() -> verifyBook(bookUrl, sourceId, result));
            RespUtils.writeJson(resp, result);
        } catch (Exception error) {
            RespUtils.writeError(resp, 500, error.getMessage() == null ? "书源验证失败" : error.getMessage());
        }
    }

    private void verifyBook(String bookUrl, int sourceId, Map<String, Object> result) {
        AppConfig config = BeanUtil.copyProperties(AppConfigLoader.APP_CONFIG, AppConfig.class);
        config.setSourceId(sourceId);
        config.setEnableProgressbar(0);

        Book book = new BookParser(config).parse(bookUrl);
        BookContext.set(book);
        try {
            List<Chapter> chapters = new TocParser(config).parseAll(bookUrl);
            if (chapters.isEmpty()) {
                throw new IllegalStateException("章节目录为空");
            }

            ChapterParser chapterParser = new ChapterParser(config);
            Chapter first = chapterParser.parse(chapters.getFirst());
            Chapter last = chapters.size() == 1 ? first : chapterParser.parse(chapters.getLast());
            if (first == null || last == null || StrUtil.isBlank(first.getContent()) || StrUtil.isBlank(last.getContent())) {
                throw new IllegalStateException("首尾章节正文抽检失败");
            }

            result.put("sourceId", sourceId);
            result.put("url", bookUrl);
            result.put("bookName", book.getBookName());
            result.put("author", book.getAuthor());
            result.put("category", book.getCategory());
            result.put("intro", book.getIntro());
            result.put("status", book.getStatus());
            result.put("latestChapter", book.getLatestChapter());
            result.put("chapterCount", chapters.size());
            result.put("sampledChapters", chapters.size() == 1 ? 1 : 2);
            result.put("available", true);
        } finally {
            BookContext.clear();
        }
    }
}
