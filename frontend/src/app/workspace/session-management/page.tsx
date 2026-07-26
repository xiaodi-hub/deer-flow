"use client";

import { ExternalLink, Trash2 } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  ThreadChannelBadge,
  ThreadChannelIcon,
} from "@/components/workspace/thread-channel-source";
import {
  WorkspaceBody,
  WorkspaceContainer,
  WorkspaceHeader,
} from "@/components/workspace/workspace-container";
import { useI18n } from "@/core/i18n/hooks";
import { useDeleteThread, useInfiniteThreads } from "@/core/threads/hooks";
import {
  channelSourceOfThread,
  pathOfThread,
  titleOfThread,
} from "@/core/threads/utils";
import { formatTimeAgo } from "@/core/utils/datetime";
import { env } from "@/env";
import { cn } from "@/lib/utils";

export default function SessionManagementPage() {
  const { t } = useI18n();
  const {
    data: infiniteThreads,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteThreads();
  const deleteThread = useDeleteThread();
  const threads = useMemo(
    () => infiniteThreads?.pages.flat() ?? [],
    [infiniteThreads],
  );
  const [search, setSearch] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const isSearching = search.trim().length > 0;
  const isDemoMode = env.NEXT_PUBLIC_STATIC_WEBSITE_ONLY === "true";

  useEffect(() => {
    document.title = `${t.pages.sessionManagement} - ${t.pages.appName}`;
  }, [t.pages.appName, t.pages.sessionManagement]);

  const filteredThreads = useMemo(() => {
    const query = search.trim().toLowerCase();
    return threads.filter((thread) => {
      return titleOfThread(thread).toLowerCase().includes(query);
    });
  }, [threads, search]);

  useEffect(() => {
    const loadedIds = new Set(threads.map((thread) => thread.thread_id));
    setSelectedIds((current) => {
      const next = new Set(
        [...current].filter((threadId) => loadedIds.has(threadId)),
      );
      return next.size === current.size ? current : next;
    });
  }, [threads]);

  const visibleIds = useMemo(
    () => filteredThreads.map((thread) => thread.thread_id),
    [filteredThreads],
  );
  const selectedVisibleCount = visibleIds.filter((threadId) =>
    selectedIds.has(threadId),
  ).length;
  const allVisibleSelected =
    visibleIds.length > 0 && selectedVisibleCount === visibleIds.length;

  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const element = sentinelRef.current;
    if (!element || !hasNextPage || isSearching) {
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting && hasNextPage && !isFetchingNextPage) {
          void fetchNextPage();
        }
      },
      { rootMargin: "200px 0px 200px 0px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [fetchNextPage, hasNextPage, isFetchingNextPage, isSearching]);

  const toggleVisible = () => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (allVisibleSelected) {
        visibleIds.forEach((threadId) => next.delete(threadId));
      } else {
        visibleIds.forEach((threadId) => next.add(threadId));
      }
      return next;
    });
  };

  const toggleThread = (threadId: string) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(threadId)) {
        next.delete(threadId);
      } else {
        next.add(threadId);
      }
      return next;
    });
  };

  const handleBulkDelete = async () => {
    const idsToDelete = [...selectedIds];
    if (idsToDelete.length === 0 || isDemoMode) {
      return;
    }

    setIsDeleting(true);
    const results = await Promise.allSettled(
      idsToDelete.map((threadId) => deleteThread.mutateAsync({ threadId })),
    );
    setIsDeleting(false);
    setConfirmOpen(false);

    const deletedIds = idsToDelete.filter(
      (_, index) => results[index]?.status === "fulfilled",
    );
    const failedCount = idsToDelete.length - deletedIds.length;
    setSelectedIds((current) => {
      const next = new Set(current);
      deletedIds.forEach((threadId) => next.delete(threadId));
      return next;
    });

    if (failedCount > 0) {
      toast.error(
        t.chats.bulkDeletePartialFailure(deletedIds.length, failedCount),
      );
    } else {
      toast.success(t.chats.bulkDeleteSuccess(deletedIds.length));
    }
  };

  return (
    <WorkspaceContainer>
      <WorkspaceHeader />
      <WorkspaceBody>
        <div className="flex size-full flex-col">
          <header className="mx-auto flex w-full max-w-(--container-width-lg) shrink-0 flex-col gap-4 px-4 pt-8">
            <div className="flex flex-col gap-1">
              <h1 className="text-2xl font-semibold">
                {t.chats.sessionManagementTitle}
              </h1>
              <p className="text-muted-foreground text-sm">
                {t.chats.sessionManagementDescription}
              </p>
            </div>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              <Input
                type="search"
                className="h-11 text-base sm:flex-1"
                placeholder={t.chats.searchChats}
                autoFocus
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <div className="flex shrink-0 items-center gap-2">
                <Button
                  variant="outline"
                  onClick={toggleVisible}
                  disabled={visibleIds.length === 0 || isDeleting}
                >
                  {t.chats.selectAllVisible}
                </Button>
                <Button
                  variant="destructive"
                  onClick={() => setConfirmOpen(true)}
                  disabled={selectedIds.size === 0 || isDeleting || isDemoMode}
                >
                  <Trash2 />
                  {t.chats.bulkDelete}
                </Button>
              </div>
            </div>
            <div className="text-muted-foreground text-sm">
              {isDemoMode
                ? t.common.notAvailableInDemoMode
                : t.chats.selectedCount(selectedIds.size)}
            </div>
          </header>
          <main className="min-h-0 flex-1">
            <ScrollArea className="size-full py-4">
              <div className="mx-auto flex size-full max-w-(--container-width-lg) flex-col px-4">
                {filteredThreads.length === 0 && (
                  <div className="text-muted-foreground flex h-48 items-center justify-center text-sm">
                    {t.chats.noChats}
                  </div>
                )}
                {filteredThreads.map((thread) => {
                  const channelSource = channelSourceOfThread(thread);
                  const selected = selectedIds.has(thread.thread_id);
                  return (
                    <div
                      key={thread.thread_id}
                      className={cn(
                        "flex items-start gap-3 border-b py-4",
                        selected && "bg-muted/35",
                      )}
                    >
                      <input
                        type="checkbox"
                        className="mt-1 size-4 shrink-0 accent-current"
                        aria-label={titleOfThread(thread)}
                        checked={selected}
                        onChange={() => toggleThread(thread.thread_id)}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 items-center gap-2">
                          <ThreadChannelIcon source={channelSource} />
                          <div className="min-w-0 flex-1 truncate font-medium">
                            {titleOfThread(thread)}
                          </div>
                          <ThreadChannelBadge
                            source={channelSource}
                            className="hidden sm:inline-flex"
                          />
                        </div>
                        {thread.updated_at && (
                          <div className="text-muted-foreground mt-2 text-sm">
                            {formatTimeAgo(thread.updated_at)}
                          </div>
                        )}
                      </div>
                      <Button variant="ghost" size="icon" asChild>
                        <Link
                          href={pathOfThread(thread)}
                          aria-label={titleOfThread(thread)}
                        >
                          <ExternalLink />
                        </Link>
                      </Button>
                    </div>
                  );
                })}
                {hasNextPage && !isSearching && (
                  <div
                    ref={sentinelRef}
                    aria-hidden="true"
                    className="h-px w-full"
                    data-testid="session-management-sentinel"
                  />
                )}
                {hasNextPage && isSearching && (
                  <div className="flex justify-center p-4">
                    <Button
                      variant="outline"
                      onClick={() => void fetchNextPage()}
                      disabled={isFetchingNextPage}
                      data-testid="session-management-load-more"
                    >
                      {isFetchingNextPage
                        ? t.chats.loadingMore
                        : t.chats.loadMoreToSearch}
                    </Button>
                  </div>
                )}
              </div>
            </ScrollArea>
          </main>
        </div>
      </WorkspaceBody>
      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t.chats.bulkDeleteConfirmTitle}</DialogTitle>
            <DialogDescription>
              {t.chats.bulkDeleteConfirmDescription(selectedIds.size)}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setConfirmOpen(false)}
              disabled={isDeleting}
            >
              {t.common.cancel}
            </Button>
            <Button
              variant="destructive"
              onClick={() => void handleBulkDelete()}
              disabled={isDeleting || selectedIds.size === 0}
            >
              {isDeleting ? t.common.loading : t.chats.bulkDelete}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </WorkspaceContainer>
  );
}
