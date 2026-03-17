import type { Store } from '../store/index.js';
import { SpecDir } from '../spec/types.js';
import {
  EpicDir, initEpic, listAllEpics, removeEpic,
  topologicalOrder, nextActionable,
} from '../epic/index.js';

interface RosterParams {
  action: string;
  project_path?: string;
  epic_slug?: string;
  task_slug?: string;
  name?: string;
  depends_on?: string;
  status?: string;
  confirm?: boolean;
}

function jsonResult(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] };
}

function errorResult(msg: string) {
  return { content: [{ type: 'text' as const, text: JSON.stringify({ error: msg }) }], isError: true as const };
}

export async function handleRoster(_store: Store, params: RosterParams) {
  const projectPath = params.project_path || process.cwd();

  switch (params.action) {
    case 'init': return rosterInit(projectPath, params);
    case 'status': return rosterStatus(projectPath, params);
    case 'link': return rosterLink(projectPath, params);
    case 'unlink': return rosterUnlink(projectPath, params);
    case 'order': return rosterOrder(projectPath, params);
    case 'list': return rosterList(projectPath);
    case 'update': return rosterUpdate(projectPath, params);
    case 'delete': return rosterDelete(projectPath, params);
    default: return errorResult(`unknown action: ${params.action}`);
  }
}

function rosterInit(projectPath: string, params: RosterParams) {
  if (!params.epic_slug) return errorResult('epic_slug is required for init');
  const name = params.name || params.epic_slug;

  try {
    initEpic(projectPath, params.epic_slug, name);
  } catch (err) {
    return errorResult(`${err}`);
  }

  return jsonResult({
    epic_slug: params.epic_slug,
    name,
    status: 'draft',
    message: `Epic "${name}" created`,
  });
}

function rosterStatus(projectPath: string, params: RosterParams) {
  if (!params.epic_slug) return errorResult('epic_slug is required for status');

  const ed = new EpicDir(projectPath, params.epic_slug);
  if (!ed.exists()) return errorResult(`epic "${params.epic_slug}" not found`);

  try {
    const ep = ed.read();
    const tasks = ep.tasks ?? [];
    const completed = tasks.filter(t => t.status === 'completed').length;
    const total = tasks.length;
    const actionable = nextActionable(tasks);

    return jsonResult({
      epic_slug: params.epic_slug,
      name: ep.name,
      status: ep.status,
      completed,
      total,
      progress_pct: total > 0 ? Math.round((completed / total) * 100) : 0,
      tasks: tasks.map(t => ({
        slug: t.slug,
        status: t.status,
        depends_on: t.depends_on ?? [],
      })),
      next_actionable: actionable,
    });
  } catch (err) {
    return errorResult(`${err}`);
  }
}

function rosterLink(projectPath: string, params: RosterParams) {
  if (!params.epic_slug) return errorResult('epic_slug is required for link');
  if (!params.task_slug) return errorResult('task_slug is required for link');

  // Validate task exists as a spec.
  const sd = new SpecDir(projectPath, params.task_slug);
  if (!sd.exists()) return errorResult(`task "${params.task_slug}" has no spec directory`);

  const dependsOn = params.depends_on ? params.depends_on.split(',').map(s => s.trim()).filter(Boolean) : [];
  const ed = new EpicDir(projectPath, params.epic_slug);

  try {
    ed.link(params.task_slug, dependsOn);
  } catch (err) {
    return errorResult(`${err}`);
  }

  return jsonResult({
    epic_slug: params.epic_slug,
    task_slug: params.task_slug,
    depends_on: dependsOn,
    message: `Task "${params.task_slug}" linked to epic "${params.epic_slug}"`,
  });
}

function rosterUnlink(projectPath: string, params: RosterParams) {
  if (!params.epic_slug) return errorResult('epic_slug is required for unlink');
  if (!params.task_slug) return errorResult('task_slug is required for unlink');

  const ed = new EpicDir(projectPath, params.epic_slug);
  try {
    ed.unlink(params.task_slug);
  } catch (err) {
    return errorResult(`${err}`);
  }

  return jsonResult({
    epic_slug: params.epic_slug,
    task_slug: params.task_slug,
    message: `Task "${params.task_slug}" unlinked from epic "${params.epic_slug}"`,
  });
}

function rosterOrder(projectPath: string, params: RosterParams) {
  if (!params.epic_slug) return errorResult('epic_slug is required for order');

  const ed = new EpicDir(projectPath, params.epic_slug);
  try {
    const ep = ed.read();
    const tasks = ep.tasks ?? [];
    const order = topologicalOrder(tasks);
    return jsonResult({
      epic_slug: params.epic_slug,
      recommended_order: order,
    });
  } catch (err) {
    return errorResult(`${err}`);
  }
}

function rosterList(projectPath: string) {
  const summaries = listAllEpics(projectPath);
  return jsonResult({
    epics: summaries.map(s => ({
      epic_slug: s.slug,
      name: s.name,
      status: s.status,
      completed: s.completed,
      total: s.total,
      progress_pct: s.total > 0 ? Math.round((s.completed / s.total) * 100) : 0,
    })),
    count: summaries.length,
  });
}

function rosterUpdate(projectPath: string, params: RosterParams) {
  if (!params.epic_slug) return errorResult('epic_slug is required for update');

  const ed = new EpicDir(projectPath, params.epic_slug);
  if (!ed.exists()) return errorResult(`epic "${params.epic_slug}" not found`);

  try {
    const ep = ed.read();
    if (params.name) ep.name = params.name;
    if (params.status) ep.status = params.status;
    ed.save(ep);

    return jsonResult({
      epic_slug: params.epic_slug,
      name: ep.name,
      status: ep.status,
      message: `Epic "${params.epic_slug}" updated`,
    });
  } catch (err) {
    return errorResult(`${err}`);
  }
}

function rosterDelete(projectPath: string, params: RosterParams) {
  if (!params.epic_slug) return errorResult('epic_slug is required for delete');

  const ed = new EpicDir(projectPath, params.epic_slug);
  if (!ed.exists()) return errorResult(`epic "${params.epic_slug}" not found`);

  if (!params.confirm) {
    // Dry-run: preview.
    try {
      const ep = ed.read();
      const tasks = ep.tasks ?? [];
      return jsonResult({
        epic_slug: params.epic_slug,
        name: ep.name,
        task_count: tasks.length,
        tasks: tasks.map(t => t.slug),
        warning: 'Tasks (specs) will NOT be deleted — they become standalone. Pass confirm=true to proceed.',
      });
    } catch (err) {
      return errorResult(`${err}`);
    }
  }

  try {
    removeEpic(projectPath, params.epic_slug);
  } catch (err) {
    return errorResult(`${err}`);
  }

  return jsonResult({
    epic_slug: params.epic_slug,
    deleted: true,
    message: `Epic "${params.epic_slug}" deleted. Tasks preserved as standalone.`,
  });
}
