// ============================================================
// Supabase Edge Function: job-worker  (v2.18.0 云端任务队列)
//   v2.18.0：新增卡死页回收（running 超 6 分钟自动重扫，最多2次）+ 收尾前检查残留 running 页，
//            修复"进程中途被中断→页永久停在解析中、任务却提前收尾"导致的重复页码显示问题
// 职责：把「扫描入库」变成云端自动执行的任务，浏览器可随时关闭。
//   action=create  前端提交：把图片清单落成一个任务单 + 每页明细，状态 queued
//   action=tick    pg_cron 每分钟唤醒：原子领取一个任务，推进其中一页
//                   （先 detect-page 识别真实页码 → 再 scan-page 入库），天然断点续传
//   action=accept  验收：服务端校验 sync_code 后，把 done 任务置为 accepted 归档
//   action=retry   重试某失败页：把该页状态复位 pending，任务重新排队
// 全部写库用 service_role；识别/入库逻辑完全复用 detect-page 与 scan-page，
// 不重复实现、不改识别规则、不改词库结构。密钥只在服务端使用。
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { ...CORS, "Content-Type": "application/json" },
});

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const db = () => createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// 内部调用本项目的 Edge Function（复用现成识别/入库逻辑，service_role 鉴权）
async function callFn(name: string, payload: unknown): Promise<{ ok: boolean; data: any }> {
  const r = await fetch(`${SUPABASE_URL}/functions/v1/${name}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
    body: JSON.stringify(payload),
  });
  const text = await r.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 400) }; }
  return { ok: r.ok && !!data?.ok, data };
}

// 批次号：JOB-YYYYMMDD-HHmmss-随机4位
function genJobNo() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
  const rnd = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `JOB-${stamp}-${rnd}`;
}

// 页清单指纹：按 image_path/url 排序后简单哈希，防同一批图片重复提交
function fingerprintOf(pages: any[]): string {
  const s = pages.map(p => String(p.image_path || p.image_url || "")).sort().join("|");
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const supa = db();
  try {
    const body = await req.json();
    const action = String(body.action || "tick");

    // ---------- create：前端提交，落库任务单 + 明细 ----------
    if (action === "create") {
      const { sync_code, book_id = "victor", pages, job_no } = body;
      if (!sync_code) return json({ ok: false, error: "缺少 sync_code" }, 400);
      if (!Array.isArray(pages) || !pages.length) return json({ ok: false, error: "页清单为空" }, 400);
      const fp = fingerprintOf(pages);
      // 同一批图片 + 同一同步码，10 分钟内视为同一任务，直接返回旧任务（防重复提交）
      const { data: dup } = await supa.from("vw_scan_jobs")
        .select("id,job_no,status,total_pages,done_pages")
        .eq("sync_code", sync_code).eq("fingerprint", fp)
        .gte("created_at", new Date(Date.now() - 10 * 60 * 1000).toISOString())
        .order("id", { ascending: false }).limit(1);
      if (dup && dup.length) return json({ ok: true, job: dup[0], duplicated: true });

      const no = job_no || genJobNo();
      const { data: job, error: jErr } = await supa.from("vw_scan_jobs").insert({
        job_no: no, sync_code, book_id, status: "queued", total_pages: pages.length,
        fingerprint: fp,
      }).select().single();
      if (jErr || !job) return json({ ok: false, error: "建任务失败：" + (jErr?.message || "") }, 500);

      const rows = pages.map((p: any, i: number) => ({
        job_id: job.id, sync_code, seq: i + 1,
        image_url: p.image_url, image_path: p.image_path || null,
        status: "pending",
      }));
      const { error: pErr } = await supa.from("vw_scan_job_pages").insert(rows);
      if (pErr) {
        await supa.from("vw_scan_jobs").delete().eq("id", job.id);
        return json({ ok: false, error: "建任务明细失败：" + pErr.message }, 500);
      }
      return json({ ok: true, job, duplicated: false });
    }

    // ---------- tick：pg_cron 定时推进一页 ----------
    if (action === "tick") {
      const now = Date.now();
      // 软锁超时（5 分钟未推进视为卡死，可回收）。先释放过期锁。
      await supa.from("vw_scan_jobs").update({ locked_at: null })
        .in("status", ["queued", "running"])
        .lt("locked_at", new Date(now - 5 * 60 * 1000).toISOString());

      // 领取一个待推进任务（queued 或 running，未锁定），按创建时间升序
      const { data: jobs } = await supa.from("vw_scan_jobs")
        .select("id,job_no,book_id,sync_code,status,total_pages,done_pages,failed_pages")
        .in("status", ["queued", "running"])
        .is("locked_at", null)
        .order("created_at", { ascending: true }).limit(1);
      if (!jobs || !jobs.length) return json({ ok: true, idle: true });
      const job = jobs[0];

      // 原子加锁：仅当 locked_at 仍为空时才领到（防 pg_cron 并发重叠）
      const { data: locked } = await supa.from("vw_scan_jobs")
        .update({ locked_at: new Date().toISOString(), status: "running", started_at: job.started_at || new Date().toISOString() })
        .eq("id", job.id).is("locked_at", null).select("id");
      if (!locked || !locked.length) return json({ ok: true, idle: true, note: "任务已被其它实例领取" });

      // 卡死页回收（v2.18.0）：worker 进程若在解析中途被平台中断（冷启动/超时/重启），
      // 该页会永远停在 running——软锁回收只释放任务锁，不会重置页状态，于是前端永久"解析中"。
      // 这里把 running 且 started_at 超过 6 分钟的页复位为 pending 自动重扫（幂等安全），
      // 并用 error_msg 里的 STALE 标记限制最多回收 2 次，避免问题页无限循环。
      const STALE_MS = 6 * 60 * 1000;
      const { data: stalePages } = await supa.from("vw_scan_job_pages")
        .select("id,error_msg,started_at")
        .eq("status", "running")
        .lt("started_at", new Date(now - STALE_MS).toISOString())
        .limit(20);
      for (const sp of (stalePages || [])) {
        const m = /STALE-RECOVER:(\d+)/.exec(String(sp.error_msg || ""));
        const times = m ? parseInt(m[1], 10) : 0;
        if (times >= 2) {
          // 已回收两次仍卡死：标为 error，交人工处理，不再自动重扫
          await supa.from("vw_scan_job_pages").update({
            status: "error", finished_at: new Date().toISOString(),
            error_msg: "解析多次中断，已停止自动重试，请点重试或删除该页",
          }).eq("id", sp.id);
        } else {
          await supa.from("vw_scan_job_pages").update({
            status: "pending", started_at: null,
            error_msg: `STALE-RECOVER:${times + 1} 进程中断，已自动重扫`,
          }).eq("id", sp.id);
        }
      }

      let page: any = null;
      try {
        // 取本任务下一页 pending（按 seq）；若无则检查是否所有页都已终态 → done
        const { data: pend } = await supa.from("vw_scan_job_pages")
          .select("id,seq,page_no,image_url,image_path,status")
          .eq("job_id", job.id).eq("status", "pending")
          .order("seq", { ascending: true }).limit(1);

        if (!pend || !pend.length) {
          // 无 pending 页：先看是否仍有 running 页（可能是别的实例在处理，或未超时的卡死页）
          const { data: allPre } = await supa.from("vw_scan_job_pages")
            .select("status").eq("job_id", job.id);
          const stillRunning = (allPre || []).filter(p => p.status === "running").length;
          if (stillRunning > 0) {
            // 有页仍在处理中，暂不收尾，下一 tick 再看；回收逻辑会处理超时的卡死页
            await supa.from("vw_scan_jobs").update({ locked_at: null }).eq("id", job.id);
            return json({ ok: true, note: "仍有页处理中，暂不收尾", job_id: job.id, stillRunning });
          }
          // 全部终态：统计，收尾任务
          const { data: all } = await supa.from("vw_scan_job_pages")
            .select("status,words_found").eq("job_id", job.id);
          const done = (all || []).filter(p => p.status === "done").length;
          const failed = (all || []).filter(p => p.status === "error").length;
          const words = (all || []).reduce((s, p) => s + (Number(p.words_found) || 0), 0);
          await supa.from("vw_scan_jobs").update({
            status: "done", done_pages: done, failed_pages: failed, words_found: words,
            finished_at: new Date().toISOString(), locked_at: null,
          }).eq("id", job.id);
          return json({ ok: true, finalized: true, job_id: job.id, done, failed, words });
        }

        page = pend[0];
        await supa.from("vw_scan_job_pages").update({
          status: "running", started_at: new Date().toISOString(),
        }).eq("id", page.id);

        // 1) 识别真实页码（若已有 page_no 则跳过）
        //    关键：拿到 detect 创建的 batch_id，传给 scan-page，让同一条批次随入库更新为 done
        //    （v2.16.3 修复：此前 batchId 恒为 null，导致批次永远停在 detected/0词）
        let pageNo = page.page_no || 0;
        let batchId = page.batch_id || null;
        if (!(pageNo > 0)) {
          const det = await callFn("detect-page", {
            imageUrl: page.image_url, imagePath: page.image_path,
            bookId: job.book_id, expectedPage: null,
          });
          if (!det.ok) throw new Error("页码识别失败：" + (det.data?.error || ""));
          pageNo = Number(det.data?.page_no) || 0;
          if (!(pageNo > 0)) throw new Error("未能识别页码");
          if (det.data?.batch_id) batchId = det.data.batch_id;
        }
        // 兜底：若仍无 batch_id（如历史页重试），按 image_url 找已存在的 detected 批次复用
        if (!batchId) {
          const { data: bs } = await supa.from("vw_scan_batches")
            .select("id").eq("image_url", page.image_url).eq("book_id", job.book_id)
            .order("id", { ascending: true }).limit(1);
          if (bs && bs.length) batchId = bs[0].id;
        }
        await supa.from("vw_scan_job_pages").update({ page_no: pageNo, batch_id: batchId }).eq("id", page.id);

        // 2) 跨页上下文：优先本任务上一页 done 的 nextContext，否则由 scan-page 自己查握手池
        let prevContext = null;
        const { data: prev } = await supa.from("vw_scan_job_pages")
          .select("result").eq("job_id", job.id).eq("status", "done")
          .lt("seq", page.seq).order("seq", { ascending: false }).limit(1);
        if (prev && prev.length && prev[0].result?.nextContext) prevContext = prev[0].result.nextContext;

        // 3) 解析入库（复用 scan-page 全部幂等/握手池逻辑）
        const scan = await callFn("scan-page", {
          imageUrl: page.image_url, bookId: job.book_id, pageNo,
          batchId, prevContext, force: false,
        });
        if (!scan.ok) throw new Error(scan.data?.error || "解析入库失败");

        const d = scan.data || {};
        await supa.from("vw_scan_job_pages").update({
          status: "done", words_found: d.words_found || 0,
          senses_found: d.senses_found || 0, api_calls: d.reconciliation?.api_calls || 1,
          batch_id: batchId || d.batch_id || null, result: d, error_msg: null,
          finished_at: new Date().toISOString(),
        }).eq("id", page.id);

        // 更新任务进度（重算，避免并发误差）
        const { data: all2 } = await supa.from("vw_scan_job_pages")
          .select("status,words_found").eq("job_id", job.id);
        const done2 = (all2 || []).filter(p => p.status === "done").length;
        const failed2 = (all2 || []).filter(p => p.status === "error").length;
        const words2 = (all2 || []).reduce((s, p) => s + (Number(p.words_found) || 0), 0);
        const allSettled = done2 + failed2 >= (all2?.length || 0);
        await supa.from("vw_scan_jobs").update({
          done_pages: done2, failed_pages: failed2, words_found: words2,
          status: allSettled ? "done" : "running",
          finished_at: allSettled ? new Date().toISOString() : null,
          locked_at: null,
        }).eq("id", job.id);

        return json({ ok: true, job_id: job.id, page_id: page.id, page_no: pageNo,
          words_found: d.words_found || 0, done: done2, total: all2?.length || 0, settled: allSettled });
      } catch (e: any) {
        const msg = String(e?.message || e);
        // 该页失败，单独标记，不影响其它页继续推进
        if (page && page.id) {
          await supa.from("vw_scan_job_pages").update({
            status: "error", error_msg: msg.slice(0, 500), finished_at: new Date().toISOString(),
          }).eq("id", page.id);
        }
        const { data: all3 } = await supa.from("vw_scan_job_pages")
          .select("status").eq("job_id", job.id);
        const settled = (all3 || []).every(p => p.status === "done" || p.status === "error");
        await supa.from("vw_scan_jobs").update({
          status: settled ? "done" : "running",
          failed_pages: (all3 || []).filter(p => p.status === "error").length,
          finished_at: settled ? new Date().toISOString() : null,
          locked_at: null,
        }).eq("id", job.id);
        return json({ ok: true, page_error: true, job_id: job.id, error: msg });
      }
    }

    // ---------- setpage：手动修正某页识别错误的页码（首字母页被误读成页码）----------
    // 精准定位：用该页 scan 回执里的词头白名单 + 旧页码 + 书名，只迁这批词，
    // 绝不碰同一旧页码下其它真实词条（如 P19 真实的 allow/allocate 那批）。
    if (action === "setpage") {
      const { page_id, sync_code, new_page_no } = body;
      const newNo = parseInt(new_page_no, 10);
      if (!page_id || !sync_code || !(newNo > 0)) return json({ ok: false, error: "参数不完整或页码无效" }, 400);

      const { data: pg, error: pgErr } = await supa.from("vw_scan_job_pages")
        .select("id,job_id,sync_code,page_no,image_url,image_path,result,status")
        .eq("id", Number(page_id)).maybeSingle();
      if (pgErr) return json({ ok: false, error: "查询明细失败：" + pgErr.message }, 500);
      if (!pg) return json({ ok: false, error: "明细页不存在 id=" + page_id }, 404);
      if (pg.sync_code !== sync_code) return json({ ok: false, error: "同步码不匹配，无权修改" }, 403);
      // book_id 在任务主表上，按 job_id 取
      const { data: jRow } = await supa.from("vw_scan_jobs").select("book_id").eq("id", pg.job_id).maybeSingle();
      const bookId = jRow?.book_id || "victor";
      const oldNo = pg.page_no;
      if (!(oldNo > 0)) return json({ ok: false, error: "该页尚无页码，无法修正" }, 400);
      if (oldNo === newNo) return json({ ok: true, note: "页码未变", page_no: oldNo });

      // 词头白名单：来自本页 scan 回执，最精准的锚点
      const words: string[] = Array.isArray(pg.result?.words) ? pg.result.words.map(String) : [];
      if (!words.length) return json({ ok: false, error: "该页没有可迁移的词条记录" }, 400);

      // 1) 迁移词条页码：限 书名 + 旧页码 + 词头白名单
      let moved = 0;
      for (const hw of words) {
        const { data: upd } = await supa.from("vw_words")
          .update({ page_no: newNo })
          .eq("book_id", bookId).eq("page_no", oldNo).eq("headword", hw)
          .select("id");
        if (upd && upd.length) moved += upd.length;
      }

      // 2) 更新任务明细页码 + 回执里的 page_no
      const newResult = { ...(pg.result || {}), page_no: newNo, page_corrected_from: oldNo };
      await supa.from("vw_scan_job_pages").update({
        page_no: newNo, result: newResult,
      }).eq("id", page_id);

      // 3) 同步更新对应导入批次（按 image_url 精确定位）
      if (pg.image_url) {
        await supa.from("vw_scan_batches").update({ page_no: newNo })
          .eq("book_id", bookId).eq("image_url", pg.image_url);
      }

      // 4) 握手池：把该页两侧记录的页码同步改正（避免跨页上下文仍指向错页）
      await supa.from("vw_page_handshakes").update({ page_no: newNo })
        .eq("book_id", bookId).eq("page_no", oldNo);
      await supa.from("vw_page_handshakes").update({ neighbor_page_no: newNo })
        .eq("book_id", bookId).eq("neighbor_page_no", oldNo);

      return json({ ok: true, page_id, old_page_no: oldNo, new_page_no: newNo,
        words_moved: moved, word_heads: words.length });
    }

    // ---------- accept：验收归档（服务端校验 sync_code）----------
    if (action === "accept") {
      const { job_id, sync_code } = body;
      if (!job_id || !sync_code) return json({ ok: false, error: "缺少参数" }, 400);
      const { data: job } = await supa.from("vw_scan_jobs")
        .select("id,sync_code,status").eq("id", job_id).single();
      if (!job) return json({ ok: false, error: "任务不存在" }, 404);
      if (job.sync_code !== sync_code) return json({ ok: false, error: "同步码不匹配，无权验收" }, 403);
      if (job.status === "accepted") return json({ ok: true, job, note: "已验收" });
      const { data: upd, error } = await supa.from("vw_scan_jobs")
        .update({ status: "accepted", accepted_at: new Date().toISOString(), locked_at: null })
        .eq("id", job_id).select().single();
      if (error) return json({ ok: false, error: error.message }, 500);
      return json({ ok: true, job: upd });
    }

    // ---------- retry：重试失败页 ----------
    if (action === "retry") {
      const { page_id, sync_code } = body;
      if (!page_id || !sync_code) return json({ ok: false, error: "缺少参数" }, 400);
      const { data: pg } = await supa.from("vw_scan_job_pages")
        .select("id,job_id,sync_code,status").eq("id", page_id).single();
      if (!pg || pg.sync_code !== sync_code) return json({ ok: false, error: "无权操作该页" }, 403);
      await supa.from("vw_scan_job_pages").update({
        status: "pending", error_msg: null, page_no: null, started_at: null, finished_at: null,
      }).eq("id", page_id);
      await supa.from("vw_scan_jobs").update({ status: "queued", locked_at: null }).eq("id", pg.job_id);
      return json({ ok: true });
    }

    return json({ ok: false, error: "未知 action：" + action }, 400);
  } catch (err: any) {
    return json({ ok: false, error: String(err?.message || err) }, 500);
  }
});
