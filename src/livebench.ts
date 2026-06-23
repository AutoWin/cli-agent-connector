import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { join } from "node:path";
import { AgentConfig, AgentModelConfig, ConnectorConfig, PromptAttachment } from "./types.js";

export interface LiveBenchModelScores {
  modelId: string;
  globalScore: number;
  categoryScores: Record<string, number>;
  taskScores: Record<string, number>;
}

export interface LiveBenchData {
  release: string;
  categories: Record<string, string[]>;
  models: Map<string, LiveBenchModelScores>;
  loadedAt: string;
  source: "cache" | "network";
}

export interface LiveBenchModelChoice {
  agent: AgentConfig;
  model: AgentModelConfig;
  category: string;
  rawScore: number;
  adjustedScore: number;
  order: number;
}

export class LiveBenchService {
  private cached?: LiveBenchData;

  constructor(private readonly config: ConnectorConfig) {}

  async refresh(force = false): Promise<LiveBenchData | undefined> {
    const settings = this.config.benchmarks.livebench;
    if (!settings.enabled) {
      this.cached = undefined;
      return undefined;
    }

    const cache = this.cachePaths();
    await mkdir(cache.dir, { recursive: true });
    if (!force && (await this.cacheIsFresh(cache.table, cache.categories))) {
      this.cached = await this.loadFromCache(cache.table, cache.categories);
      return this.cached;
    }

    try {
      const [table, categories] = await Promise.all([
        downloadText(`${settings.baseUrl}/table_${releaseFileKey(settings.release)}.csv`),
        downloadText(`${settings.baseUrl}/categories_${releaseFileKey(settings.release)}.json`)
      ]);
      await Promise.all([writeFile(cache.table, table, "utf8"), writeFile(cache.categories, categories, "utf8")]);
      this.cached = parseLiveBenchData(settings.release, table, categories, "network");
      return this.cached;
    } catch (error) {
      if (await filesExist(cache.table, cache.categories)) {
        this.cached = await this.loadFromCache(cache.table, cache.categories);
        return this.cached;
      }
      throw error;
    }
  }

  async getData(): Promise<LiveBenchData | undefined> {
    if (this.cached) {
      return this.cached;
    }
    try {
      return await this.refresh(false);
    } catch {
      return undefined;
    }
  }

  async scoreForModel(model: AgentModelConfig, category: string): Promise<number | undefined> {
    const data = await this.getData();
    if (!data) {
      return undefined;
    }
    return this.scoreFromData(data, model, category);
  }

  async chooseModel(agent: AgentConfig, category: string): Promise<LiveBenchModelChoice | undefined> {
    const data = await this.getData();
    if (!data || !agent.models?.length) {
      return undefined;
    }

    return enabledModels(agent)
      .map((model, order): LiveBenchModelChoice | undefined => {
        const rawScore = this.scoreFromData(data, model, category);
        if (rawScore === undefined) {
          return undefined;
        }
        const adjustedScore = rawScore - (model.costHint ?? agent.costHint) * 1.5;
        return { agent, model, category, rawScore, adjustedScore, order };
      })
      .filter(isChoice)
      .sort(compareChoices)[0];
  }

  async bestConfiguredModel(category: string): Promise<LiveBenchModelChoice | undefined> {
    const data = await this.getData();
    if (!data) {
      return undefined;
    }
    const choices: LiveBenchModelChoice[] = [];
    let order = 0;
    for (const agent of this.config.agents) {
      if (!agent.enabled) {
        continue;
      }
      for (const model of enabledModels(agent)) {
        const rawScore = this.scoreFromData(data, model, category);
        if (rawScore !== undefined) {
          choices.push({
            agent,
            model,
            category,
            rawScore,
            adjustedScore: rawScore,
            order: order++
          });
        }
      }
    }
    return choices.sort((a, b) => b.rawScore - a.rawScore || a.order - b.order)[0];
  }

  private scoreFromData(data: LiveBenchData, model: AgentModelConfig, category: string): number | undefined {
    const id = liveBenchModelId(model);
    const row = data.models.get(id);
    if (!row) {
      return undefined;
    }
    return row.categoryScores[category] ?? row.globalScore;
  }

  private async loadFromCache(tablePath: string, categoriesPath: string): Promise<LiveBenchData> {
    const [table, categories] = await Promise.all([readFile(tablePath, "utf8"), readFile(categoriesPath, "utf8")]);
    return parseLiveBenchData(this.config.benchmarks.livebench.release, table, categories, "cache");
  }

  private cachePaths(): { dir: string; table: string; categories: string } {
    const dir = join(this.config.state.path, "benchmarks", "livebench");
    const release = releaseFileKey(this.config.benchmarks.livebench.release);
    return {
      dir,
      table: join(dir, `table_${release}.csv`),
      categories: join(dir, `categories_${release}.json`)
    };
  }

  private async cacheIsFresh(tablePath: string, categoriesPath: string): Promise<boolean> {
    const ttl = this.config.benchmarks.livebench.cacheTtlMs;
    if (ttl <= 0) {
      return false;
    }
    try {
      const [tableInfo, categoriesInfo] = await Promise.all([stat(tablePath), stat(categoriesPath)]);
      return Date.now() - Math.min(tableInfo.mtimeMs, categoriesInfo.mtimeMs) <= ttl;
    } catch {
      return false;
    }
  }
}

export function parseLiveBenchData(
  release: string,
  tableCsv: string,
  categoriesJson: string,
  source: "cache" | "network" = "cache"
): LiveBenchData {
  const categories = parseCategories(categoriesJson);
  const rows = parseCsv(tableCsv);
  if (rows.length < 2) {
    return { release, categories, models: new Map(), loadedAt: new Date().toISOString(), source };
  }

  const header = rows[0].map((item) => item.trim());
  const modelColumn = header.findIndex((item) => /^model$/i.test(item));
  const modelIndex = modelColumn >= 0 ? modelColumn : 0;
  const taskIndexes = new Map<string, number>();
  header.forEach((name, index) => {
    if (index !== modelIndex && name) {
      taskIndexes.set(name, index);
    }
  });

  const models = new Map<string, LiveBenchModelScores>();
  for (const row of rows.slice(1)) {
    const modelId = row[modelIndex]?.trim();
    if (!modelId) {
      continue;
    }
    const taskScores: Record<string, number> = {};
    for (const [task, index] of taskIndexes) {
      const score = numberCell(row[index]);
      if (score !== undefined) {
        taskScores[task] = score;
      }
    }
    const categoryScores = computeCategoryScores(taskScores, categories);
    const globalScore = average(Object.values(categoryScores)) ?? average(Object.values(taskScores)) ?? 0;
    models.set(normalizeBenchmarkId(modelId), {
      modelId,
      globalScore,
      categoryScores,
      taskScores
    });
  }

  return { release, categories, models, loadedAt: new Date().toISOString(), source };
}

export function inferLiveBenchCategory(prompt: string, attachments: PromptAttachment[], mode?: string): string {
  const text = `${prompt}\n${attachments.map((item) => `${item.kind} ${item.label} ${item.path ?? ""} ${item.content ?? ""}`).join("\n")}`.toLowerCase();
  if (/\b(sql|csv|jsonl|dataframe|pandas|spreadsheet|chart|dataset|analytics?|metric|kpi|etl|table|join)\b/.test(text)) {
    return "Data Analysis";
  }
  if (/\b(test|debug|bug|refactor|implement|code|typescript|javascript|python|react|node|api|function|class|compile|build)\b/.test(text)) {
    return mode === "plan" ? "Agentic Coding" : "Coding";
  }
  if (/\b(agent|tool|terminal|filesystem|patch|repo|workspace|multi[- ]?step|autonomous)\b/.test(text)) {
    return "Agentic Coding";
  }
  if (/\b(math|proof|calculate|equation|integral|derivative|probability|algebra|geometry|olympiad)\b/.test(text)) {
    return "Mathematics";
  }
  if (/\b(summarize|rewrite|translate|grammar|tone|language|paraphrase|story|draft|email)\b/.test(text)) {
    return "Language";
  }
  if (/\b(instruction|format|exactly|constraint|must|json schema|follow)\b/.test(text)) {
    return "IF";
  }
  return "Reasoning";
}

export function liveBenchModelId(model: AgentModelConfig): string {
  return normalizeBenchmarkId(model.benchmarkModelId ?? model.id);
}

export function normalizeBenchmarkId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^.*\//, "")
    .replace(/\s+/g, "-");
}

function parseCategories(json: string): Record<string, string[]> {
  const parsed = JSON.parse(json) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {};
  }
  const output: Record<string, string[]> = {};
  for (const [category, tasks] of Object.entries(parsed)) {
    if (Array.isArray(tasks)) {
      output[category] = tasks.filter((task): task is string => typeof task === "string");
    }
  }
  return output;
}

function computeCategoryScores(taskScores: Record<string, number>, categories: Record<string, string[]>): Record<string, number> {
  const output: Record<string, number> = {};
  for (const [category, tasks] of Object.entries(categories)) {
    const score = average(tasks.map((task) => taskScores[task]).filter(isNumber));
    if (score !== undefined) {
      output[category] = score;
    }
  }
  return output;
}

function parseCsv(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;

  for (let index = 0; index < input.length; index++) {
    const char = input[index];
    const next = input[index + 1];
    if (quoted) {
      if (char === '"' && next === '"') {
        cell += '"';
        index++;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (char !== "\r") {
      cell += char;
    }
  }

  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((items) => items.some((item) => item.trim().length > 0));
}

function numberCell(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const normalized = value.trim().replace(/%$/, "");
  if (!normalized || normalized === "-") {
    return undefined;
  }
  const number = Number(normalized);
  return Number.isFinite(number) ? number : undefined;
}

function average(values: number[]): number | undefined {
  if (values.length === 0) {
    return undefined;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function enabledModels(agent: AgentConfig): AgentModelConfig[] {
  return (agent.models ?? []).filter((model) => model.enabled);
}

function compareChoices(a: LiveBenchModelChoice, b: LiveBenchModelChoice): number {
  return b.adjustedScore - a.adjustedScore || b.rawScore - a.rawScore || a.order - b.order;
}

function isChoice(value: LiveBenchModelChoice | undefined): value is LiveBenchModelChoice {
  return Boolean(value);
}

function isNumber(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function releaseFileKey(release: string): string {
  return release.replaceAll("-", "_");
}

async function filesExist(...paths: string[]): Promise<boolean> {
  try {
    await Promise.all(paths.map((path) => stat(path)));
    return true;
  } catch {
    return false;
  }
}

async function downloadText(url: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const client = url.startsWith("https:") ? httpsRequest : httpRequest;
    const request = client(url, (response) => {
      if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        void downloadText(new URL(response.headers.location, url).toString()).then(resolve, reject);
        response.resume();
        return;
      }
      if (response.statusCode !== 200) {
        reject(new Error(`GET ${url} failed with HTTP ${response.statusCode ?? "unknown"}.`));
        response.resume();
        return;
      }
      response.setEncoding("utf8");
      let body = "";
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => resolve(body));
    });
    request.on("error", reject);
    request.setTimeout(20_000, () => {
      request.destroy(new Error(`GET ${url} timed out.`));
    });
    request.end();
  });
}
