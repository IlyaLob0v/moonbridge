import type { ContentBundle } from "@moonbridge/content";
import type { SendOutcome, Statement, StatementSink } from "@moonbridge/xapi";
import type { Snapshot } from "./backup.js";

export interface AccountInfo {
  id: string;
  name: string;
  role: "student" | "teacher";
  login: string;
  /** Where reminders and password reset links go; null until the person gives one. Missing in sessions saved before e-mail existed. */
  email?: string | null;
  /** False once the person unsubscribed from reminders. */
  reminders?: boolean;
}

/** What the gateway answers to a sign-in or a join. */
export interface SignedIn {
  token: string;
  player_id: string;
  registration: string;
  account: AccountInfo;
}

export interface SlotView {
  weekday: number;
  time: string;
  minutes: number;
}

export interface SubmissionView {
  submission_id: string;
  account_id: string;
  student_name: string;
  /** Null for a Moonbridge unit's result, which has a score instead of a file. */
  file_name: string | null;
  mime: string | null;
  size: number | null;
  /** A unit's result: tasks right on the first try out of all, and the grade that suggests. */
  score: { right: number; total: number; suggested_grade: number } | null;
  submitted_at: string;
  /** The teacher's grade (1–5) and comment; null until the teacher has looked at this file. */
  review: { grade: number; comment: string; reviewed_at: string } | null;
}

/** A student's practice in a week, from their answers. */
export interface PracticeView {
  /** Moscow dates (YYYY-MM-DD) with practice. */
  days: string[];
  answers: number;
  minutes: number;
  /** First-try accuracy in per cent; null without answers. */
  accuracy: number | null;
  errors: { error_type: string; label: string; count: number }[];
  modes: { mode: string; answers: number; right: number }[];
  last_answered_at: string | null;
}

/** Held lessons in a week and how many the student was present at or missed. */
export interface AttendanceCount {
  held: number;
  present: number;
  absent: number;
}

export interface GroupProgress {
  week: { from: string; to: string };
  students: { id: string; name: string; week: PracticeView; homework_open: number; lessons?: AttendanceCount }[];
}

export type LessonStatus = "planned" | "held" | "cancelled";
export type AttendanceStatus = "present" | "absent";

export interface LessonMaterial {
  title: string;
  url: string;
}

/** One lesson of a group; it happens in the video service behind call_url. */
export interface LessonView {
  lesson_id: string;
  group_id: string;
  group_name: string;
  starts_at: string;
  ends_at: string;
  minutes: number;
  status: LessonStatus;
  topic: string;
  /** The lesson's own link, or else the group's. */
  call_url: string | null;
  materials: LessonMaterial[];
  recording_url: string | null;
  note: string;
  /** Files the teacher attached; missing in a dashboard kept from an older version. */
  files?: LessonFileView[];
}

export interface LessonFileView {
  file_id: string;
  file_name: string;
  mime: string;
  size: number;
}

/** A student's view: their own mark on a held lesson. */
export interface StudentLesson extends LessonView {
  attendance: AttendanceStatus | null;
}

/** A teacher's view: every student of the group with their mark. */
export interface TeacherLesson extends LessonView {
  attendance: { account_id: string; name: string; status: AttendanceStatus | null }[];
}

export interface LessonChanges {
  starts_at?: string;
  minutes?: number;
  status?: "planned" | "cancelled";
  topic?: string;
  call_url?: string | null;
  materials?: LessonMaterial[];
  recording_url?: string | null;
  note?: string;
}

export type MetricStatus = "ok" | "below" | "no_data";
export interface Metric {
  value: number | null;
  target: number;
  status: MetricStatus;
}

/** The pilot's metrics for a group (apps/server/src/school/metrics.ts). */
export interface PilotMetrics {
  from: string;
  weeks: { from: string; to: string; complete: boolean; active: number; avgDays: number; medianSessionMinutes: number | null; voluntaryStudents: number; lostOffered: number; lostReturned: number }[];
  students: { id: string; name: string; days: number[]; sessions: number; voluntary: number; medianSessionMinutes: number | null; lostOffered: number; lostReturned: number }[];
  summary: {
    practiceDays: Metric;
    active: Metric & { week: number | null; students: number; of: number };
    sessionMinutes: Metric;
    voluntaryShare: Metric;
    lostReturned: Metric & { returned: number; offered: number };
    errorTypes: {
      improved: number;
      compared: number;
      trends: { errorType: string; label: string; firstWeek: string; firstAccuracy: number; lastWeek: string; lastAccuracy: number; change: number }[];
    };
  };
}

export interface FeedbackView {
  id: string;
  name: string;
  role: "student" | "teacher";
  page: string;
  message: string;
  user_agent: string;
  at: string;
}

/** Reminders by e-mail: sent, opened from the button, followed by practice within 2 hours. */
export interface EmailCounts {
  sent: number;
  clicked: number;
  practiced: number;
}
export interface EmailMetrics extends EmailCounts {
  students: number;
  withEmail: number;
  unsubscribed: number;
  byKind: Record<"evening" | "deadline" | "grade", EmailCounts>;
  weeks: (EmailCounts & { from: string })[];
}

export interface GroupMetrics {
  group: { id: string; name: string };
  pilot_from: string | null;
  metrics: PilotMetrics;
  /** Null when the gateway has no e-mail. */
  email?: EmailMetrics | null;
  feedback: FeedbackView[];
}

export interface StudentReport {
  student: { id: string; name: string };
  week: { from: string; to: string };
  practice: PracticeView;
  previous: { days: number; accuracy: number | null };
  homework: HomeworkView[];
  /** The week's lessons that have started, with the student's marks. */
  lessons?: AttendanceCount & { lessons: StudentLesson[] };
}

export interface QueueItem extends SubmissionView {
  homework_title: string;
}

export interface GroupView {
  group_id: string;
  name: string;
  teacher_name: string;
  call_url: string | null;
  schedule: SlotView[];
  /** "assigned": a unit opens in the hotel when the teacher gives it as homework; "course": units open in course order by themselves. */
  unit_access: "assigned" | "course";
  /** Teachers only. */
  members?: { id: string; name: string }[];
}

export interface HomeworkView {
  homework_id: string;
  group_id: string;
  title: string;
  description: string;
  due_at: string | null;
  needs_file: boolean;
  /** A Moonbridge unit from the lesson catalog, played instead of handed in. */
  module_id: string | null;
  /** One student of the group; null = the whole group. */
  account_id: string | null;
  assignee_name: string | null;
  auto_grade: boolean;
  created_at: string;
  /** Students, for a unit: its episodes and which of them they have played since it was given. */
  unit?: { title: string; episodes: { episode_id: string; title: string; done: boolean }[] };
  /** Students: their own hand-in. */
  submission?: SubmissionView | null;
  /** Teachers: everyone's hand-ins. */
  submissions?: SubmissionView[];
}

/** The student's or the teacher's school: groups, schedule and homework. */
export interface Dashboard {
  account: AccountInfo;
  groups: GroupView[];
  homework: HomeworkView[];
  /**
   * A student: the coming two weeks and the last month. A teacher: the coming week and the
   * ended lessons that wait for attendance. Missing in a dashboard kept from an older version.
   */
  lessons?: (StudentLesson | TeacherLesson)[];
}

export interface NewGroup {
  name: string;
  call_url: string | null;
  schedule: SlotView[];
}

export interface NewHomework {
  title?: string;
  description?: string;
  due_at: string | null;
  needs_file?: boolean;
  module_id?: string;
  account_id?: string | null;
  auto_grade?: boolean;
}

/** A unit of the lesson catalog (apps/server/src/school/units.ts). */
export interface CatalogUnit {
  module_id: string;
  cefr_level: string;
  title: { en: string; ru: string };
  description: string | null;
  skill: string;
  episodes: { episode_id: string; title: string; place: string; tasks: number }[];
  tasks: number;
}

/** What the client knows about its session; persisted so the game starts offline too. */
export interface SessionInfo {
  token?: string;
  playerId: string;
  registration: string;
  xapiBaseIri: string;
  /** "lti" sessions come from an LMS launch and cannot be renewed by the client; "account" ones need the password again when they expire. */
  kind: "guest" | "lti" | "account";
  account?: AccountInfo;
  /** custom.module_id of the LMS link, if the launch is bound to one module. */
  ltiModuleId?: string;
}

export const DEFAULT_XAPI_BASE_IRI = "https://moonbridge.example.com";

export class ApiError extends Error {
  /** The gateway's own explanation, in Russian, when it gave one. */
  readonly userMessage: string | undefined;
  constructor(readonly status: number, message: string, userMessage?: string) {
    super(message);
    this.userMessage = userMessage;
  }
}

/** A signed-in account whose session has expired: the student signs in again. */
export class SignedOutError extends Error {}

/** Client of the integration gateway (apps/server). */
/** The live content as the teacher's cabinet shows it. */
export interface ContentState {
  content_hash: string;
  units: number;
  tasks: number;
  episodes: number;
  /** False where the server keeps no published versions: the content comes from the repository only. */
  editable: boolean;
  published: { at: string; by: string | null; source: string } | null;
}

export interface SheetIssue {
  severity: "error" | "warning";
  where: string;
  message: string;
}

export interface SheetResult {
  ok: boolean;
  issues: SheetIssue[];
  summary: {
    units: { id: string; title: string; tasks: number }[];
    tasks: number;
    episodes: number;
    added: string[];
    changed: string[];
    removed: string[];
  } | null;
  content?: ContentState;
}

/** A content sheet: a Google Sheets link or an .xlsx file. */
export type SheetInput = { url: string } | File;

export class Api {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly base: string, fetchImpl?: typeof fetch) {
    this.base = base.replace(/\/$/, "");
    this.fetchImpl = fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  private async json<T>(path: string, init: RequestInit = {}, token?: string): Promise<T> {
    const headers = new Headers(init.headers);
    if (token) headers.set("Authorization", `Bearer ${token}`);
    if (init.body) headers.set("Content-Type", "application/json");
    const res = await this.fetchImpl(`${this.base}${path}`, { ...init, headers, signal: AbortSignal.timeout(15000) });
    if (!res.ok) {
      const body = (await res.json().catch(() => undefined)) as { message?: string } | undefined;
      throw new ApiError(res.status, `${init.method ?? "GET"} ${path}: HTTP ${res.status}`, body?.message);
    }
    return (await res.json()) as T;
  }

  authOptions() {
    return this.json<{ guest: boolean; password_reset?: boolean }>("/auth/options");
  }

  /** "Забыли пароль?": the gateway answers the same whether or not the login exists. */
  forgotPassword(login: string) {
    return this.json<{ ok: true; message: string }>("/auth/forgot", { method: "POST", body: JSON.stringify({ login }) });
  }

  /** Whether a reset link from an e-mail still works. */
  checkReset(token: string) {
    return this.json<{ ok: true }>(`/auth/reset/${encodeURIComponent(token)}`);
  }

  /** Sets the new password from a reset link and signs in. */
  resetByLink(token: string, password: string) {
    return this.json<SignedIn>("/auth/reset", { method: "POST", body: JSON.stringify({ token, password }) });
  }

  setEmail(token: string, email: string | null) {
    return this.json<{ account: AccountInfo }>("/account/email", { method: "PUT", body: JSON.stringify({ email }) }, token);
  }

  setReminders(token: string, on: boolean) {
    return this.json<{ account: AccountInfo }>("/account/reminders", { method: "PUT", body: JSON.stringify({ on }) }, token);
  }

  login(login: string, password: string) {
    return this.json<SignedIn>("/auth/login", { method: "POST", body: JSON.stringify({ login, password }) });
  }

  invite(code: string) {
    return this.json<{ group: { name: string; teacher_name: string } }>(`/invites/${encodeURIComponent(code)}`);
  }

  /** Joins the invitation's group: a new student account, or the signed-in one when `token` is an account's. */
  join(code: string, fields: { name: string; login: string; password: string; email?: string } | undefined, token?: string) {
    return this.json<SignedIn & { group: GroupView }>(`/invites/${encodeURIComponent(code)}/join`, { method: "POST", body: JSON.stringify(fields ?? {}) }, token);
  }

  dashboard(token: string) {
    return this.json<Dashboard>("/school/dashboard", {}, token);
  }

  createGroup(token: string, group: NewGroup) {
    return this.json<{ group: GroupView }>("/school/groups", { method: "POST", body: JSON.stringify(group) }, token);
  }

  updateGroup(token: string, groupId: string, patch: Partial<NewGroup> & { unit_access?: GroupView["unit_access"] }) {
    return this.json<{ group: GroupView }>(`/school/groups/${groupId}`, { method: "PATCH", body: JSON.stringify(patch) }, token);
  }

  createInvite(token: string, groupId: string) {
    return this.json<{ code: string; url: string; expires_at: string }>(`/school/groups/${groupId}/invites`, { method: "POST" }, token);
  }

  createHomework(token: string, groupId: string, hw: NewHomework) {
    return this.json<{ homework: HomeworkView }>(`/school/groups/${groupId}/homework`, { method: "POST", body: JSON.stringify(hw) }, token);
  }

  /** The lesson catalog: units in course order with their Moonbridge episodes. */
  catalog(token: string) {
    return this.json<{ units: CatalogUnit[] }>("/school/catalog", {}, token);
  }

  /** The account's lessons: the last two months and the coming four weeks. */
  lessons(token: string) {
    return this.json<{ lessons: StudentLesson[] }>("/school/lessons", {}, token);
  }

  groupLessons(token: string, groupId: string) {
    return this.json<{ group: { group_id: string; name: string; call_url: string | null }; lessons: TeacherLesson[] }>(`/school/groups/${groupId}/lessons`, {}, token);
  }

  createLesson(token: string, groupId: string, lesson: { starts_at: string; minutes: number; topic?: string }) {
    return this.json<{ lesson: TeacherLesson }>(`/school/groups/${groupId}/lessons`, { method: "POST", body: JSON.stringify(lesson) }, token);
  }

  updateLesson(token: string, lessonId: string, changes: LessonChanges) {
    return this.json<{ lesson: TeacherLesson }>(`/school/lessons/${lessonId}`, { method: "PATCH", body: JSON.stringify(changes) }, token);
  }

  /** Present or absent for each student; the lesson becomes held. */
  markAttendance(token: string, lessonId: string, marks: { account_id: string; status: AttendanceStatus }[]) {
    return this.json<{ lesson: TeacherLesson }>(`/school/lessons/${lessonId}/attendance`, { method: "PUT", body: JSON.stringify({ marks }) }, token);
  }

  groupProgress(token: string, groupId: string) {
    return this.json<GroupProgress>(`/school/groups/${groupId}/progress`, {}, token);
  }

  /** The weekly report on a student; `week` is any Moscow date in the week, the current week by default. */
  studentReport(token: string, accountId: string, week?: string) {
    return this.json<StudentReport>(`/school/students/${accountId}/report${week ? `?week=${week}` : ""}`, {}, token);
  }

  groupMetrics(token: string, groupId: string) {
    return this.json<GroupMetrics>(`/school/groups/${groupId}/metrics`, {}, token);
  }

  setPilotFrom(token: string, groupId: string, from: string) {
    return this.json<{ pilot_from: string }>(`/school/groups/${groupId}/pilot`, { method: "PUT", body: JSON.stringify({ from }) }, token);
  }

  /** "Сообщить о проблеме". */
  sendFeedback(token: string, message: string, page: string) {
    return this.json<{ id: string }>("/feedback", { method: "POST", body: JSON.stringify({ message, page }) }, token);
  }

  reviewQueue(token: string) {
    return this.json<{ submissions: QueueItem[] }>("/school/review-queue", {}, token);
  }

  review(token: string, submissionId: string, grade: number, comment: string) {
    return this.json<{ submission: SubmissionView }>(`/school/submissions/${submissionId}/review`, { method: "POST", body: JSON.stringify({ grade, comment }) }, token);
  }

  resetPassword(token: string, accountId: string) {
    return this.json<{ login: string; password: string }>(`/school/students/${accountId}/password`, { method: "POST" }, token);
  }

  contentState(token: string) {
    return this.json<ContentState>("/school/content", {}, token);
  }

  /** The live content as an .xlsx sheet, to edit and publish back. */
  async contentSheet(token: string): Promise<Blob> {
    const res = await this.fetchImpl(`${this.base}/school/content/sheet`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new ApiError(res.status, `GET /school/content/sheet: HTTP ${res.status}`);
    return res.blob();
  }

  /**
   * Checks or publishes a sheet. A sheet with errors comes back as a result (ok: false) with the
   * errors, not as an exception: the teacher needs to see them.
   */
  async sheet(token: string, what: "check" | "publish", input: SheetInput): Promise<SheetResult> {
    const file = input instanceof File;
    const res = await this.fetchImpl(`${this.base}/school/content/${what}${file ? `?name=${encodeURIComponent(input.name)}` : ""}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": file ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" : "application/json",
      },
      body: file ? input : JSON.stringify(input),
      // Google can take a while to export a big sheet.
      signal: AbortSignal.timeout(60000),
    });
    const body = (await res.json().catch(() => undefined)) as (SheetResult & { message?: string }) | undefined;
    if (res.ok || (res.status === 422 && body?.issues)) return body!;
    throw new ApiError(res.status, `POST /school/content/${what}: HTTP ${res.status}`, body?.message);
  }

  /** A short-lived link to a handed-in file, which the browser opens as an ordinary download. */
  async submissionLink(token: string, submissionId: string): Promise<string> {
    const { url } = await this.json<{ url: string }>(`/school/submissions/${submissionId}/link`, { method: "POST" }, token);
    return `${this.base}${url}`;
  }

  /**
   * Sends a hand-in file as the request body. XMLHttpRequest rather than fetch, because a
   * 50 MB recording on a phone connection needs a progress bar.
   */
  /** Attaches a file to a lesson; the answer is the lesson with its files. */
  uploadLessonFile(token: string, lessonId: string, file: File, onProgress?: (fraction: number) => void): Promise<TeacherLesson> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("PUT", `${this.base}/school/lessons/${lessonId}/files?name=${encodeURIComponent(file.name)}`);
      xhr.setRequestHeader("Authorization", `Bearer ${token}`);
      xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
      xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
      xhr.onload = () => {
        let body: { lesson?: TeacherLesson; message?: string } | undefined;
        try {
          body = JSON.parse(xhr.responseText) as typeof body;
        } catch {
          body = undefined;
        }
        if (xhr.status === 201 && body?.lesson) resolve(body.lesson);
        else reject(new ApiError(xhr.status, `lesson file: HTTP ${xhr.status}`, body?.message));
      };
      xhr.onerror = () => reject(new ApiError(0, "lesson file: network error", "Нет связи. Попробуйте ещё раз, когда появится интернет."));
      xhr.send(file);
    });
  }

  deleteLessonFile(token: string, lessonId: string, fileId: string) {
    return this.json<{ lesson: TeacherLesson }>(`/school/lessons/${lessonId}/files/${fileId}`, { method: "DELETE" }, token);
  }

  /** A five-minute download link to a lesson file. */
  async lessonFileLink(token: string, fileId: string): Promise<string> {
    const { url } = await this.json<{ url: string }>(`/school/lesson-files/${fileId}/link`, { method: "POST" }, token);
    return `${this.base}${url}`;
  }

  uploadSubmission(token: string, homeworkId: string, file: File, onProgress?: (fraction: number) => void): Promise<SubmissionView> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("PUT", `${this.base}/school/homework/${homeworkId}/submission?name=${encodeURIComponent(file.name)}`);
      xhr.setRequestHeader("Authorization", `Bearer ${token}`);
      xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
      xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
      xhr.onload = () => {
        let body: { submission?: SubmissionView; message?: string } | undefined;
        try {
          body = JSON.parse(xhr.responseText) as typeof body;
        } catch {
          body = undefined;
        }
        if (xhr.status === 201 && body?.submission) resolve(body.submission);
        else reject(new ApiError(xhr.status, `upload: HTTP ${xhr.status}`, body?.message));
      };
      xhr.onerror = () => reject(new ApiError(0, "upload: network error", "Нет связи. Попробуйте ещё раз, когда появится интернет."));
      xhr.send(file);
    });
  }

  guest(previousPlayerId?: string) {
    return this.json<{ token: string; player_id: string; registration: string }>("/session/guest", {
      method: "POST",
      body: JSON.stringify(previousPlayerId ? { player_id: previousPlayerId } : {}),
    });
  }

  me(token: string) {
    return this.json<{ player_id: string; registration: string; xapi_base_iri: string; lti: { module_id: string | null } | null; account?: { id: string; role: string } | null }>(
      "/session/me",
      {},
      token,
    );
  }

  /** The content bundle, or "not-modified" when the cached hash is still current. */
  async bundle(cachedHash?: string): Promise<ContentBundle | "not-modified"> {
    const res = await this.fetchImpl(`${this.base}/content/bundle`, {
      headers: cachedHash ? { "If-None-Match": `"${cachedHash}"` } : {},
      signal: AbortSignal.timeout(15000),
    });
    if (res.status === 304) return "not-modified";
    if (!res.ok) throw new ApiError(res.status, `GET /content/bundle: HTTP ${res.status}`);
    return (await res.json()) as ContentBundle;
  }

  moduleResult(token: string, body: { module_id: string; correct: number; total: number }) {
    return this.json<{ passed: boolean; best: number; lms: string }>("/progress/module-result", { method: "POST", body: JSON.stringify(body) }, token);
  }

  /** The server's copy of the game state, or undefined when there is none yet. */
  async getSnapshot(token: string): Promise<Snapshot | undefined> {
    try {
      return await this.json<Snapshot>("/progress/snapshot", {}, token);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return undefined;
      throw e;
    }
  }

  /** Stores the game state; false when the server already holds a newer save. */
  async putSnapshot(token: string, body: Snapshot): Promise<boolean> {
    try {
      await this.json("/progress/snapshot", { method: "PUT", body: JSON.stringify(body) }, token);
      return true;
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) return false;
      throw e;
    }
  }

  /** Posts statements to the gateway's xAPI intake, with the same outcome contract as an LRS client. */
  async postStatements(token: string | undefined, statements: Statement[]): Promise<SendOutcome> {
    if (statements.length === 0) return { kind: "sent", ids: [] };
    if (!token) return { kind: "retry", reason: "no session yet" };
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}/xapi/statements`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(statements),
        signal: AbortSignal.timeout(15000),
      });
    } catch (e) {
      return { kind: "retry", reason: `network: ${(e as Error).message}` };
    }
    if (res.ok) return { kind: "sent", ids: statements.map((s) => s.id) };
    // 401: the session expired. The statements are fine; they go out after the session is renewed.
    if (res.status === 401 || res.status === 429 || res.status >= 500) return { kind: "retry", reason: `HTTP ${res.status}` };
    return { kind: "rejected", status: res.status, reason: (await res.text().catch(() => "")).slice(0, 500) };
  }
}

/** The client side of the outbox delivers to the gateway, which owns the LRS credentials. */
export class GatewaySink implements StatementSink {
  constructor(private readonly api: Api, private readonly token: () => string | undefined, private readonly onUnauthorized?: () => void) {}

  async send(statements: Statement[]): Promise<SendOutcome> {
    const outcome = await this.api.postStatements(this.token(), statements);
    if (outcome.kind === "retry" && outcome.reason === "HTTP 401") this.onUnauthorized?.();
    return outcome;
  }
}

export interface SessionStorage {
  load(): SessionInfo | undefined;
  save(s: SessionInfo): void;
}

export const localSessionStorage: SessionStorage = {
  load() {
    try {
      const raw = localStorage.getItem("moonbridge.session");
      return raw ? (JSON.parse(raw) as SessionInfo) : undefined;
    } catch {
      return undefined;
    }
  },
  save(s) {
    try {
      localStorage.setItem("moonbridge.session", JSON.stringify(s));
    } catch {
      // Private mode: the session lives for this page only.
    }
  },
};

/** Reads `#session=<token>&module=<id>` left by an LTI launch. */
export function sessionFromFragment(hash: string): { token: string; moduleId?: string } | undefined {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const token = params.get("session");
  if (!token) return undefined;
  const moduleId = params.get("module");
  return { token, ...(moduleId ? { moduleId } : {}) };
}

/**
 * Starts a session: an LTI launch token from the URL wins, then the stored session,
 * then a guest session. Without a network the stored session (or a new local guest
 * id) is used, and statements wait in the outbox until the gateway is reachable.
 */
export async function startSession(api: Api, store: SessionStorage, fragment: string): Promise<{ session: SessionInfo; online: boolean }> {
  const launch = sessionFromFragment(fragment);
  const stored = store.load();
  try {
    if (launch) {
      const me = await api.me(launch.token);
      const session: SessionInfo = {
        token: launch.token,
        playerId: me.player_id,
        registration: me.registration,
        xapiBaseIri: me.xapi_base_iri,
        kind: "lti",
        ...(launch.moduleId ? { ltiModuleId: launch.moduleId } : {}),
      };
      store.save(session);
      return { session, online: true };
    }
    if (stored?.token) {
      try {
        const me = await api.me(stored.token);
        const session = { ...stored, registration: me.registration, xapiBaseIri: me.xapi_base_iri };
        store.save(session);
        return { session, online: true };
      } catch (e) {
        if (e instanceof ApiError && e.status === 401 && stored.kind === "account") throw new SignedOutError("the account session has expired");
        if (!(e instanceof ApiError && e.status === 401) || stored.kind === "lti") throw e;
      }
    }
    const session = await renewGuest(api, stored?.playerId);
    store.save(session);
    return { session, online: true };
  } catch (e) {
    if (e instanceof SignedOutError || (e instanceof ApiError && e.status !== 401 && e.status < 500)) throw e;
    const session: SessionInfo = stored ?? {
      playerId: `guest_${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`,
      registration: crypto.randomUUID(),
      xapiBaseIri: DEFAULT_XAPI_BASE_IRI,
      kind: "guest",
    };
    store.save(session);
    return { session, online: false };
  }
}

/** The session of a student or teacher who has just signed in or joined a group. */
export function accountSession(s: SignedIn, xapiBaseIri: string): SessionInfo {
  return { token: s.token, playerId: s.player_id, registration: s.registration, xapiBaseIri, kind: "account", account: s.account };
}

export async function renewGuest(api: Api, previousPlayerId?: string): Promise<SessionInfo> {
  const g = await api.guest(previousPlayerId);
  const me = await api.me(g.token);
  return { token: g.token, playerId: g.player_id, registration: g.registration, xapiBaseIri: me.xapi_base_iri, kind: "guest" };
}
