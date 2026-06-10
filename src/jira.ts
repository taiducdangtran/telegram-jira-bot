// Bọc mỏng Jira Cloud REST API v3. Auth: Basic (email + API token).

function base(env: any): string {
  return String(env.JIRA_BASE_URL || "").replace(/\/+$/, "");
}

function authHeader(env: any): string {
  // Base64 trên byte UTF-8 để không vỡ nếu email có ký tự ngoài ASCII.
  const bytes = new TextEncoder().encode(`${env.JIRA_EMAIL}:${env.JIRA_API_TOKEN}`);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return "Basic " + btoa(bin);
}

async function jreq(env: any, method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(base(env) + path, {
    method,
    headers: {
      Authorization: authHeader(env),
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const raw = await res.text();
  let data: any = null;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    data = raw;
  }
  if (!res.ok) {
    const detail = typeof data === "string" ? data : summarizeErrors(data);
    const err: any = new Error(`Jira ${res.status}: ${detail}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

// Jira trả lỗi dạng { errorMessages: [...], errors: { field: msg } }.
function summarizeErrors(data: any): string {
  if (!data || typeof data !== "object") return String(data);
  const parts: string[] = [];
  if (Array.isArray(data.errorMessages)) parts.push(...data.errorMessages);
  if (data.errors && typeof data.errors === "object") {
    for (const [k, v] of Object.entries(data.errors)) parts.push(`${k}: ${v}`);
  }
  return parts.length ? parts.join("; ") : JSON.stringify(data);
}

// Description Jira phải là ADF (Atlassian Document Format), không nhận chuỗi thường.
function adf(text: string) {
  return {
    type: "doc",
    version: 1,
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}

export const jira = {
  async createIssue(
    env: any,
    projectKey: string,
    summary: string,
    dueDateYMD: string | null,
    extra: { priority?: string | null; labels?: string[]; issueType?: string } = {},
  ): Promise<any> {
    const fields: any = {
      project: { key: projectKey },
      summary,
      issuetype: { name: extra.issueType || env.JIRA_ISSUE_TYPE || "Task" },
      description: adf("Tạo từ Telegram bot."),
    };
    if (dueDateYMD) fields.duedate = dueDateYMD; // Jira duedate chỉ nhận YYYY-MM-DD
    if (extra.priority) fields.priority = { name: extra.priority };
    if (extra.labels && extra.labels.length) fields.labels = extra.labels;
    return jreq(env, "POST", "/rest/api/3/issue", { fields }); // -> { id, key, self }
  },

  async projects(env: any): Promise<any[]> {
    const data = await jreq(env, "GET", "/rest/api/3/project/search?maxResults=50&orderBy=key");
    return data?.values || [];
  },

  async getProject(env: any, key: string): Promise<any | null> {
    try {
      return await jreq(env, "GET", `/rest/api/3/project/${encodeURIComponent(key)}`);
    } catch {
      return null;
    }
  },

  async transitions(env: any, issueKey: string): Promise<any[]> {
    const d = await jreq(env, "GET", `/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`);
    return d?.transitions || [];
  },

  async transition(env: any, issueKey: string, transitionId: string): Promise<any> {
    return jreq(env, "POST", `/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`, {
      transition: { id: transitionId },
    });
  },

  async setDueDate(env: any, issueKey: string, dueDateYMD: string): Promise<any> {
    return jreq(env, "PUT", `/rest/api/3/issue/${encodeURIComponent(issueKey)}`, {
      fields: { duedate: dueDateYMD },
    });
  },

  async setPriority(env: any, issueKey: string, name: string): Promise<any> {
    return jreq(env, "PUT", `/rest/api/3/issue/${encodeURIComponent(issueKey)}`, {
      fields: { priority: { name } },
    });
  },

  // Tìm việc bằng JQL (endpoint mới /search/jql). Trả mảng issues.
  async searchJQL(env: any, jql: string, fields: string[], maxResults = 20): Promise<any[]> {
    const data = await jreq(env, "POST", "/rest/api/3/search/jql", { jql, maxResults, fields });
    return data?.issues || [];
  },

  async getIssueFields(env: any, issueKey: string, fields: string[]): Promise<any> {
    return jreq(env, "GET", `/rest/api/3/issue/${encodeURIComponent(issueKey)}?fields=${fields.join(",")}`);
  },

  async myself(env: any): Promise<any> {
    return jreq(env, "GET", "/rest/api/3/myself");
  },

  async searchAssignable(env: any, projectKey: string, query: string): Promise<any[]> {
    const data = await jreq(
      env,
      "GET",
      `/rest/api/3/user/assignable/search?project=${encodeURIComponent(projectKey)}&query=${encodeURIComponent(query)}&maxResults=5`,
    );
    return Array.isArray(data) ? data : [];
  },

  async assign(env: any, issueKey: string, accountId: string): Promise<any> {
    return jreq(env, "PUT", `/rest/api/3/issue/${encodeURIComponent(issueKey)}/assignee`, { accountId });
  },

  async deleteIssue(env: any, issueKey: string): Promise<any> {
    return jreq(env, "DELETE", `/rest/api/3/issue/${encodeURIComponent(issueKey)}`);
  },

  issueUrl(env: any, issueKey: string): string {
    return `${base(env)}/browse/${encodeURIComponent(issueKey)}`;
  },
};
