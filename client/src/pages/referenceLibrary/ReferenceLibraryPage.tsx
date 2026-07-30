import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ReferenceBook, ReferenceBookCandidate } from "@ai-novel/shared/types/referenceLibrary";
import {
  BookOpenCheck,
  Download,
  FileSearch,
  Library,
  RefreshCw,
  Search,
  Trash2,
} from "lucide-react";
import { Link } from "react-router-dom";
import {
  createReferenceDownloadJobs,
  createReferenceSearchJob,
  getReferenceBookFileUrl,
  getReferenceSearchJob,
  listReferenceBooks,
  listReferenceDownloadJobs,
  redownloadReferenceBook,
  removeReferenceBookFile,
  retryReferenceBookImport,
} from "@/api/referenceLibrary";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "@/components/ui/toast";

function formatSize(value?: number | null): string {
  if (!value) return "--";
  return value < 1024 * 1024 ? `${Math.round(value / 1024)} KB` : `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function statusLabel(status: string): string {
  return ({ queued: "排队中", running: "执行中", succeeded: "已完成", failed: "失败", cancelled: "已取消" } as Record<string, string>)[status] ?? status;
}

function statusVariant(status: string): "default" | "secondary" | "destructive" | "outline" {
  if (status === "failed") return "destructive";
  if (status === "succeeded") return "default";
  if (status === "running") return "secondary";
  return "outline";
}

function BookActions({ book, onAction }: { book: ReferenceBook; onAction: (action: "remove" | "redownload" | "retry", id: string) => void }) {
  return (
    <div className="flex flex-wrap justify-end gap-1">
      {book.fileStatus === "available" ? <Button size="icon" variant="ghost" title="下载 EPUB" asChild><a href={getReferenceBookFileUrl(book.id)}><Download className="h-4 w-4" /></a></Button> : <Button size="icon" variant="ghost" title="重新下载" onClick={() => onAction("redownload", book.id)}><RefreshCw className="h-4 w-4" /></Button>}
      {book.knowledgeDocumentId ? <Button size="icon" variant="ghost" title="进入拆书" asChild><Link to={`/book-analysis?documentId=${book.knowledgeDocumentId}`}><FileSearch className="h-4 w-4" /></Link></Button> : null}
      {book.knowledgeDocumentId ? <Button size="icon" variant="ghost" title="打开知识文档" asChild><Link to={`/knowledge?documentId=${book.knowledgeDocumentId}`}><BookOpenCheck className="h-4 w-4" /></Link></Button> : null}
      {book.importStatus === "failed" ? <Button size="icon" variant="ghost" title="重试导入" onClick={() => onAction("retry", book.id)}><RefreshCw className="h-4 w-4" /></Button> : null}
      {book.fileStatus === "available" ? <Button size="icon" variant="ghost" title="删除 EPUB，保留知识文档" onClick={() => { if (window.confirm(`删除《${book.title}》的 EPUB 文件？知识文档会保留。`)) onAction("remove", book.id); }}><Trash2 className="h-4 w-4 text-destructive" /></Button> : null}
    </div>
  );
}

export default function ReferenceLibraryPage() {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState("search");
  const [authorText, setAuthorText] = useState("");
  const [searchJobId, setSearchJobId] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [keyword, setKeyword] = useState("");

  const searchJobQuery = useQuery({
    queryKey: ["reference-library", "search-job", searchJobId],
    queryFn: () => getReferenceSearchJob(searchJobId),
    enabled: Boolean(searchJobId),
    refetchInterval: (query) => ["queued", "running"].includes(query.state.data?.data?.status ?? "") ? 1500 : false,
  });
  const jobsQuery = useQuery({
    queryKey: ["reference-library", "download-jobs"],
    queryFn: listReferenceDownloadJobs,
    refetchInterval: (query) => (query.state.data?.data ?? []).some((job) => ["queued", "running"].includes(job.status)) ? 1500 : 10_000,
  });
  const booksQuery = useQuery({
    queryKey: ["reference-library", "books", keyword],
    queryFn: () => listReferenceBooks(keyword.trim() || undefined),
    refetchInterval: 10_000,
  });

  const searchMutation = useMutation({
    mutationFn: createReferenceSearchJob,
    onSuccess: (response) => {
      if (!response.data) return;
      setSearchJobId(response.data.id);
      setSelectedIds(new Set());
    },
  });
  const downloadMutation = useMutation({
    mutationFn: () => createReferenceDownloadJobs(searchJobId, [...selectedIds]),
    onSuccess: async () => {
      toast.success("已加入下载队列");
      setSelectedIds(new Set());
      setTab("tasks");
      await queryClient.invalidateQueries({ queryKey: ["reference-library"] });
    },
  });
  const bookActionMutation = useMutation({
    mutationFn: async (input: { action: "remove" | "redownload" | "retry"; id: string }) => {
      if (input.action === "remove") return removeReferenceBookFile(input.id);
      if (input.action === "redownload") return redownloadReferenceBook(input.id);
      return retryReferenceBookImport(input.id);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["reference-library"] });
    },
  });

  const searchJob = searchJobQuery.data?.data;
  const results = searchJob?.results ?? [];
  const groupedResults = useMemo(() => {
    const groups = new Map<string, ReferenceBookCandidate[]>();
    for (const book of results) groups.set(book.author, [...(groups.get(book.author) ?? []), book]);
    return [...groups.entries()];
  }, [results]);
  const jobs = jobsQuery.data?.data ?? [];
  const books = booksQuery.data?.data ?? [];

  const startSearch = () => {
    const authors = authorText.split(/[\n,，]+/).map((value) => value.trim()).filter(Boolean);
    if (authors.length === 0) return toast.error("请输入作者名");
    if (authors.length > 20) return toast.error("每批最多 20 个作者");
    searchMutation.mutate(authors);
  };
  const toggleCandidate = (id: string) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const runBookAction = (action: "remove" | "redownload" | "retry", id: string) => {
    bookActionMutation.mutate({ action, id });
  };

  return (
    <Tabs value={tab} onValueChange={setTab} className="mx-auto w-full max-w-7xl space-y-6 px-4 py-8 sm:px-6 lg:px-8">
      <header className="flex flex-col gap-4 border-b pb-5 md:flex-row md:items-end md:justify-between">
        <div className="space-y-2">
          <h1 className="text-3xl font-semibold tracking-normal">参考书库</h1>
          <p className="text-sm text-muted-foreground">按作者查找可用书源，下载后自动整理为可拆书的知识文档。</p>
        </div>
        <TabsList className="grid h-10 w-full grid-cols-3 md:w-[390px]">
          <TabsTrigger value="search"><Search className="mr-2 h-4 w-4" />找书</TabsTrigger>
          <TabsTrigger value="tasks"><Download className="mr-2 h-4 w-4" />下载任务</TabsTrigger>
          <TabsTrigger value="library"><Library className="mr-2 h-4 w-4" />已入库</TabsTrigger>
        </TabsList>
      </header>

      <TabsContent value="search" className="mt-0 space-y-6">
        <section className="space-y-3">
          <label className="text-sm font-medium" htmlFor="reference-authors">作者名单</label>
          <textarea
            id="reference-authors"
            value={authorText}
            onChange={(event) => setAuthorText(event.target.value)}
            className="min-h-28 w-full resize-y rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
            placeholder="每行一个作者，最多 20 个"
          />
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs text-muted-foreground">系统会验证详情页、章节目录和首尾章节。</span>
            <Button className="shrink-0 whitespace-nowrap" onClick={startSearch} disabled={searchMutation.isPending || ["queued", "running"].includes(searchJob?.status ?? "")}>
              <Search className="h-4 w-4" />搜索并验证
            </Button>
          </div>
        </section>

        {searchJob ? (
          <section className="space-y-4 border-t pt-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-3 text-sm">
                <Badge variant={statusVariant(searchJob.status)}>{statusLabel(searchJob.status)}</Badge>
                <span>{searchJob.processedAuthors}/{searchJob.totalAuthors} 位作者</span>
                <span>{searchJob.progress}%</span>
              </div>
              <Button onClick={() => downloadMutation.mutate()} disabled={selectedIds.size === 0 || downloadMutation.isPending}>
                <Download className="h-4 w-4" />下载所选（{selectedIds.size}）
              </Button>
            </div>
            {searchJob.lastError ? <p className="text-sm text-destructive">{searchJob.lastError}</p> : null}
            {groupedResults.map(([author, authorBooks]) => (
              <div key={author} className="space-y-2">
                <h2 className="text-base font-semibold">{author} <span className="font-normal text-muted-foreground">{authorBooks.length} 本</span></h2>
                <div className="divide-y border md:hidden">
                  {authorBooks.map((book) => (
                    <label key={book.id} className="flex items-start gap-3 p-4">
                      <input className="mt-1" type="checkbox" checked={selectedIds.has(book.id)} onChange={() => toggleCandidate(book.id)} aria-label={`选择 ${book.title}`} />
                      <span className="min-w-0 flex-1 space-y-2">
                        <span className="block break-words text-sm font-medium">{book.title}</span>
                        <span className="grid grid-cols-3 gap-2 text-xs text-muted-foreground">
                          <span>状态<br /><strong className="font-medium text-foreground">{book.publicationStatus || "未知"}</strong></span>
                          <span>章节<br /><strong className="font-medium text-foreground">{book.chapterCount}</strong></span>
                          <span>来源<br /><strong className="font-medium text-foreground">{book.sources.length}</strong></span>
                        </span>
                        <span className="block truncate text-xs text-muted-foreground">{book.latestChapter || "--"}</span>
                      </span>
                    </label>
                  ))}
                </div>
                <div className="hidden overflow-x-auto border md:block">
                  <table className="w-full min-w-[760px] text-sm">
                    <thead className="bg-muted/50 text-left"><tr><th className="w-12 p-3" /><th className="p-3">书名</th><th className="p-3">状态</th><th className="p-3">章节</th><th className="p-3">可用来源</th><th className="p-3">最新章节</th></tr></thead>
                    <tbody className="divide-y">
                      {authorBooks.map((book) => (
                        <tr key={book.id} className="hover:bg-muted/20">
                          <td className="p-3"><input type="checkbox" checked={selectedIds.has(book.id)} onChange={() => toggleCandidate(book.id)} aria-label={`选择 ${book.title}`} /></td>
                          <td className="p-3 font-medium">{book.title}</td>
                          <td className="p-3">{book.publicationStatus || "未知"}</td>
                          <td className="p-3">{book.chapterCount}</td>
                          <td className="p-3">{book.sources.length}</td>
                          <td className="max-w-64 truncate p-3 text-muted-foreground">{book.latestChapter || "--"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}
            {searchJob.status === "succeeded" && results.length === 0 ? <p className="py-10 text-center text-sm text-muted-foreground">没有通过下载验证的书籍。</p> : null}
          </section>
        ) : null}
      </TabsContent>

      <TabsContent value="tasks" className="mt-0">
        <div className="space-y-3 md:hidden">
          {jobs.map((job) => (
            <article key={job.id} className="space-y-3 rounded-md border p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0"><h2 className="break-words text-sm font-medium">{job.book.title}</h2><p className="text-xs text-muted-foreground">{job.book.author}</p></div>
                <Badge className="shrink-0" variant={statusVariant(job.status)}>{statusLabel(job.status)}</Badge>
              </div>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
                <div><dt className="text-muted-foreground">阶段</dt><dd className="mt-1 break-words">{job.currentStage || "--"}</dd></div>
                <div><dt className="text-muted-foreground">进度</dt><dd className="mt-1">{job.progress}%</dd></div>
                <div><dt className="text-muted-foreground">当前来源</dt><dd className="mt-1 break-words">{job.currentSource?.sourceName || "--"}</dd></div>
                <div><dt className="text-muted-foreground">尝试</dt><dd className="mt-1">{job.attemptCount}/{job.maxAttempts}</dd></div>
              </dl>
              {job.lastError ? <p className="break-words text-xs text-destructive">{job.lastError}</p> : null}
            </article>
          ))}
          {jobs.length === 0 ? <p className="py-10 text-center text-sm text-muted-foreground">暂无下载任务</p> : null}
        </div>
        <div className="hidden overflow-x-auto border md:block">
          <table className="w-full min-w-[780px] text-sm">
            <thead className="bg-muted/50 text-left"><tr><th className="p-3">书籍</th><th className="p-3">状态</th><th className="p-3">阶段</th><th className="p-3">进度</th><th className="p-3">当前来源</th><th className="p-3">错误</th></tr></thead>
            <tbody className="divide-y">
              {jobs.map((job) => (
                <tr key={job.id}><td className="p-3 font-medium">{job.book.title}<div className="text-xs font-normal text-muted-foreground">{job.book.author}</div></td><td className="p-3"><Badge variant={statusVariant(job.status)}>{statusLabel(job.status)}</Badge></td><td className="p-3">{job.currentStage || "--"}</td><td className="p-3">{job.progress}%</td><td className="p-3">{job.currentSource?.sourceName || "--"}</td><td className="max-w-64 p-3 text-xs text-destructive">{job.lastError || "--"}</td></tr>
              ))}
              {jobs.length === 0 ? <tr><td colSpan={6} className="p-10 text-center text-muted-foreground">暂无下载任务</td></tr> : null}
            </tbody>
          </table>
        </div>
      </TabsContent>

      <TabsContent value="library" className="mt-0 space-y-4">
        <div className="flex items-center gap-2">
          <input value={keyword} onChange={(event) => setKeyword(event.target.value)} className="h-10 flex-1 rounded-md border bg-background px-3 text-sm" placeholder="搜索书名或作者" />
          <Button size="icon" variant="outline" title="刷新" onClick={() => booksQuery.refetch()}><RefreshCw className="h-4 w-4" /></Button>
        </div>
        <div className="divide-y border md:hidden">
          {books.map((book) => (
            <article key={book.id} className="space-y-3 p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0"><h2 className="break-words text-sm font-medium">{book.title}</h2><p className="text-xs text-muted-foreground">{book.author}</p></div>
                <div className="flex shrink-0 gap-1"><Badge variant={book.fileStatus === "available" ? "default" : "outline"}>{book.fileStatus === "available" ? formatSize(book.fileSize) : "无文件"}</Badge><Badge variant={book.importStatus === "ready" ? "default" : book.importStatus === "failed" ? "destructive" : "secondary"}>{book.importStatus === "ready" ? "已入库" : book.importStatus === "failed" ? "导入失败" : "处理中"}</Badge></div>
              </div>
              <dl className="grid grid-cols-2 gap-3 text-xs">
                <div><dt className="text-muted-foreground">章节</dt><dd className="mt-1">{book.chapterCount ?? "--"}</dd></div>
                <div><dt className="text-muted-foreground">来源</dt><dd className="mt-1 break-words">{book.sources.map((source) => source.sourceName).join("、") || "--"}</dd></div>
              </dl>
              <BookActions book={book} onAction={runBookAction} />
            </article>
          ))}
          {books.length === 0 ? <p className="p-10 text-center text-sm text-muted-foreground">书库中还没有书</p> : null}
        </div>
        <div className="hidden overflow-x-auto border md:block">
          <table className="w-full min-w-[980px] text-sm">
            <thead className="bg-muted/50 text-left"><tr><th className="p-3">书籍</th><th className="p-3">章节</th><th className="p-3">文件</th><th className="p-3">知识文档</th><th className="p-3">来源</th><th className="p-3 text-right">操作</th></tr></thead>
            <tbody className="divide-y">
              {books.map((book) => (
                <tr key={book.id}><td className="p-3 font-medium">{book.title}<div className="text-xs font-normal text-muted-foreground">{book.author}</div></td><td className="p-3">{book.chapterCount ?? "--"}</td><td className="p-3"><Badge variant={book.fileStatus === "available" ? "default" : "outline"}>{book.fileStatus === "available" ? formatSize(book.fileSize) : "无文件"}</Badge></td><td className="p-3"><Badge variant={book.importStatus === "ready" ? "default" : book.importStatus === "failed" ? "destructive" : "secondary"}>{book.importStatus === "ready" ? "已入库" : book.importStatus === "failed" ? "导入失败" : "处理中"}</Badge></td><td className="p-3">{book.sources.map((source) => source.sourceName).join("、") || "--"}</td><td className="p-3"><BookActions book={book} onAction={runBookAction} /></td></tr>
              ))}
              {books.length === 0 ? <tr><td colSpan={6} className="p-10 text-center text-muted-foreground">书库中还没有书</td></tr> : null}
            </tbody>
          </table>
        </div>
      </TabsContent>
    </Tabs>
  );
}
