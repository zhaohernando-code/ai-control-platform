#!/usr/bin/env node
import { createServer } from "node:http";
import { resolve } from "node:path";

import { createWorkbenchProjection } from "../src/workflow/workbench-projection.js";
import { publishWorkbenchSnapshot, snapshotIssues } from "../src/workflow/workbench-snapshots.js";
import { createSchedulerDispatchPlan } from "../src/workflow/scheduler-dispatch-plan.js";
import {
  evaluateSchedulerDispatchControlPolicy,
  normalizeSchedulerDispatchControlRequest,
  recordSchedulerDispatchPolicyDecision
} from "../src/workflow/scheduler-dispatch-policy.js";
import { runAgentHealthCheck } from "../src/workflow/agent-health-checker.js";
import {
  createSchedulerDispatchRunArtifact,
  recordSchedulerDispatchRunArtifact,
  runSchedulerDispatchPlan
} from "../src/workflow/scheduler-dispatch-runner.js";
import {
  prepareSchedulerDispatchContinuationFromRunArtifact,
  recordSchedulerDispatchContinuationPrepared,
  recordSchedulerNextCycleEnqueue
} from "../src/workflow/scheduler-dispatch-continuation.js";
import {
  buildSchedulerLoopRunRegistry,
  createSchedulerLoopRunArtifact,
  evaluateSchedulerLoopRecovery,
  recordAutonomousSchedulerLoopRunArtifact,
  recordSchedulerLoopResumeAttempt,
  runSchedulerLoopDriver
} from "../src/workflow/autonomous-scheduler-loop.js";
import { createAgentContextWorkPackageProviderExecutor } from "../src/workflow/context-work-package-provider-executor.js";
import {
  prepareContinuationFromProjectStatus,
  recordProjectStatusContinuationPrepared
} from "../src/workflow/project-status-continuation.js";
import { materializeContextPackCycleFromWorkflowState } from "../src/workflow/context-pack-cycle.js";
import {
  runContextWorkPackages,
  stageContextWorkPackageDispatch
} from "../src/workflow/context-work-package-runner.js";
import {
  createSqliteWorkbenchStateStore,
  isSqliteSnapshotPath,
  mergeProjectStatusHistory,
  sqliteSnapshotIdFromInputPath,
  sqliteSnapshotInputPath
} from "../src/workflow/workbench-state-store.js";
import { createAgentKeyRouteHandler } from "./workbench-agent-key-routes.mjs";
import { handleWorkbenchBasicRoutes } from "./workbench-basic-routes.mjs";
import { createMainlineAlreadySatisfiedEvaluator } from "./workbench-mainline-evaluator.mjs";
import { handleRequirementRoutes } from "./workbench-requirement-routes.mjs";
import {
  generateRequirementPlanIfRequested,
  requirementAutoAdvanceAllowedAfterPlanReview,
  requirementAutoAdvanceEnabled,
  requirementPlanGenerationRunsInBackground,
  runRequirementAutoAdvance,
  startRequirementPlanGenerationInBackground,
  workflowStateWithProjectStatus
} from "./workbench-requirement-services.mjs";
import { handleReviewerRoutes } from "./workbench-reviewer-routes.mjs";
import { handleSchedulerDispatchRoutes } from "./workbench-scheduler-dispatch-routes.mjs";
import { handleSchedulerLoopRoutes } from "./workbench-scheduler-loop-routes.mjs";
import { handleWorkbenchContextRoutes } from "./workbench-context-routes.mjs";
import { handleContextWorkPackageRoutes } from "./workbench-context-work-package-routes.mjs";
import { createWorkbenchStaticRouteHandler } from "./workbench-static-routes.mjs";
import { handleWorkflowEvidenceRoutes } from "./workbench-workflow-evidence-routes.mjs";
import {
  DEFAULT_JSON_BODY_LIMIT_BYTES,
  jsonResponse,
  readJsonBody
} from "./workbench-http-utils.mjs";
import {
  contextWorkPackageRunOptions,
  createWorkbenchLoopClient,
  executeProjectedNextAction,
  workbenchBaseUrlFromRequest
} from "./workbench-loop-client.mjs";
import {
  appendEvent,
  createInitialWorkflowState,
  defaultEventsPath,
  defaultProjectStatusPath,
  defaultSnapshotsRoot,
  defaultStateDbPath,
  examplesRoot,
  historyPath,
  normalizeEvent,
  normalizeString,
  operatorEventIssues,
  projectionById,
  projectionInputWithProjectStatus,
  readEvents,
  readJson,
  readProjectStatus,
  readWorkflowStateFromItem,
  root,
  safeSnapshotIdPart,
  writeJson,
  writeProjectStatusState,
  writeWorkflowStateToItem
} from "./workbench-server-state-access.mjs";
import {
  backgroundContextWorkPackageOutputPath,
  backgroundContextWorkPackageRequested,
  generatedContextPackSnapshotId,
  generatedContinuationInputIssues,
  latestArtifactForEvent,
  latestSchedulerDispatchRun,
  launchContextWorkPackageBackgroundJob,
  metadataPath,
  projectionHistoryWithReadiness,
  readSchedulerWorkflowStateOutput,
  safeGeneratedContinuationPath,
  schedulerContinuationOutputPath,
  schedulerDispatchRunArtifactFromInput,
  schedulerDispatchRunIssues,
  schedulerPlanInputFromWorkflowState,
  schedulerPlanOptionsFromRequest,
  writePreparedSchedulerContinuation
} from "./workbench-server-scheduler-utils.mjs";
import {
  normalizeCliPort,
  parseWorkbenchServerCliArgs,
  workbenchServerHelpText
} from "./workbench-server-cli.mjs";

export function createWorkbenchServer(options = {}) {
  if (options.serveLegacyStatic === true || options.serve_legacy_static === true) {
    throw Object.assign(new Error("legacy static Workbench serving has been retired; serve the Workbench through the Next.js App Router runtime"), { code: "LEGACY_STATIC_WORKBENCH_RETIRED" });
  }

  const eventsPath = options.eventsPath || defaultEventsPath;
  const jsonBodyLimitBytes = Number(options.jsonBodyLimitBytes || options.json_body_limit_bytes || DEFAULT_JSON_BODY_LIMIT_BYTES);
  const serverHistoryPath = options.historyPath || historyPath;
  const projectStatusPath = options.projectStatusPath === null
    ? null
    : resolve(options.projectStatusPath || defaultProjectStatusPath);
  const snapshotsRoot = resolve(options.snapshotsRoot || defaultSnapshotsRoot);
  const allowedHistoryRoots = [examplesRoot, snapshotsRoot];
  const stateDbPath = normalizeString(options.stateDbPath || options.state_db || options.stateDb);
  const allowFixtureFileState = options.allowFixtureFileState === true;
  if (!stateDbPath && !options.stateStore && !allowFixtureFileState) {
    throw new Error("Workbench live state requires SQLite: pass stateDbPath or --state-db");
  }
  const stateStore = options.stateStore || (stateDbPath ? createSqliteWorkbenchStateStore({
      dbPath: stateDbPath,
      seedRoot: root,
      seedHistoryPath: serverHistoryPath,
      seedProjectStatusPath: projectStatusPath,
      seedEventsPath: eventsPath
    }) : null);
  const readServerHistory = () => stateStore ? stateStore.readHistory() : readJson(serverHistoryPath);
  const writeServerHistory = (history) => stateStore
    ? stateStore.writeHistory(history)
    : writeJson(serverHistoryPath, history);
  const readWorkflowState = (item) => readWorkflowStateFromItem(item, allowedHistoryRoots, stateStore);
  const writeWorkflowState = (item, workflowState) => writeWorkflowStateToItem(item, workflowState, allowedHistoryRoots, stateStore);
  const publishSnapshot = (input, publishOptions = {}) => stateStore
    ? stateStore.publishSnapshot(input)
    : publishWorkbenchSnapshot(input, publishOptions);
  const realReviewerExecutor = options.realReviewerExecutor;
  const requirementPlanGenerator = typeof options.requirementPlanGenerator === "function"
    ? options.requirementPlanGenerator
    : typeof options.requirement_plan_generator === "function"
      ? options.requirement_plan_generator
      : null;
  const disableDefaultAgentProviderExecutor = options.disableDefaultAgentProviderExecutor === true ||
    options.disable_default_agent_provider_executor === true;
  const contextWorkPackageProviderExecutor = typeof options.contextWorkPackageProviderExecutor === "function"
    ? options.contextWorkPackageProviderExecutor
    : typeof options.context_work_package_provider_executor === "function"
      ? options.context_work_package_provider_executor
      : disableDefaultAgentProviderExecutor
        ? null
        : createAgentContextWorkPackageProviderExecutor({
        cwd: root,
        stateStore,
        timeout_seconds: options.contextWorkPackageProviderTimeoutSeconds ||
          options.context_work_package_provider_timeout_seconds ||
          process.env.AI_CONTROL_WORKBENCH_CONTEXT_PROVIDER_TIMEOUT_SECONDS,
        idle_timeout_seconds: options.contextWorkPackageProviderIdleTimeoutSeconds ||
          options.context_work_package_provider_idle_timeout_seconds ||
          process.env.AI_CONTROL_WORKBENCH_CONTEXT_PROVIDER_IDLE_TIMEOUT_SECONDS,
        channels_path: options.agentChannelsPath ||
          options.agent_channels_path ||
          process.env.AI_CONTROL_WORKBENCH_AGENT_CHANNELS_PATH,
        profiles_path: options.agentProfilesPath ||
          options.agent_profiles_path ||
          process.env.AI_CONTROL_WORKBENCH_AGENT_PROFILES_PATH
      });
  const contextWorkPackageBackgroundLauncher = typeof options.contextWorkPackageBackgroundLauncher === "function"
    ? options.contextWorkPackageBackgroundLauncher
    : typeof options.context_work_package_background_launcher === "function"
      ? options.context_work_package_background_launcher
      : launchContextWorkPackageBackgroundJob;
  const workbenchProjection = (workflowState) => createWorkbenchProjection(
    projectionInputWithProjectStatus(workflowState, projectStatusPath, stateStore)
  );
  const handleStaticRoute = createWorkbenchStaticRouteHandler({
    root,
    jsonResponse
  });
  const handleAgentKeyRoute = createAgentKeyRouteHandler({
    stateStore,
    options,
    jsonBodyLimitBytes,
    jsonResponse,
    readJsonBody
  });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");

    try {
      if (handleStaticRoute.handleProjectMountRoot(url, res)) {
        return;
      }

      url.pathname = handleStaticRoute.routePathname(url.pathname);

      if (url.pathname === "/api/workbench/projection") {
        const { projection } = projectionById(url.searchParams.get("id"), readServerHistory(), allowedHistoryRoots, projectStatusPath, stateStore);
        jsonResponse(res, 200, projection);
        return;
      }

      if (url.pathname === "/api/workbench/projections") {
        const history = readServerHistory();
        jsonResponse(res, 200, projectionHistoryWithReadiness(history, allowedHistoryRoots, projectStatusPath, stateStore));
        return;
      }

      if (await handleAgentKeyRoute(url, req, res)) {
        return;
      }

      const routeContext = {
        url, req, res, root, snapshotsRoot, serverHistoryPath, eventsPath,
        stateStore, realReviewerExecutor, jsonBodyLimitBytes, jsonResponse, readJsonBody, readJson,
        readServerHistory, writeServerHistory, readWorkflowState, writeWorkflowState,
        readProjectStatus, writeProjectStatusState, publishSnapshot, snapshotIssues,
        readEvents, appendEvent, operatorEventIssues, normalizeEvent,
        createInitialWorkflowState, projectStatusPath, safeSnapshotIdPart,
        requirementPlanGenerationRunsInBackground, startRequirementPlanGenerationInBackground,
        generateRequirementPlanIfRequested, requirementPlanGenerator,
        requirementAutoAdvanceAllowedAfterPlanReview, workflowStateWithProjectStatus,
        workbenchProjection, runRequirementAutoAdvance, allowedHistoryRoots, normalizeString,
        requirementAutoAdvanceEnabled, projectionById, createSchedulerDispatchPlan,
        schedulerPlanInputFromWorkflowState, schedulerPlanOptionsFromRequest,
        normalizeSchedulerDispatchControlRequest, evaluateSchedulerDispatchControlPolicy,
        recordSchedulerDispatchPolicyDecision, runSchedulerDispatchPlan,
        createSchedulerDispatchRunArtifact, readSchedulerWorkflowStateOutput,
        recordSchedulerDispatchRunArtifact, prepareSchedulerDispatchContinuationFromRunArtifact,
        writePreparedSchedulerContinuation, recordSchedulerDispatchContinuationPrepared,
        metadataPath, latestSchedulerDispatchRun, safeGeneratedContinuationPath,
        schedulerContinuationOutputPath, generatedContinuationInputIssues, latestArtifactForEvent,
        recordSchedulerNextCycleEnqueue, schedulerDispatchRunIssues,
        schedulerDispatchRunArtifactFromInput, resolve, runSchedulerLoopDriver,
        prepareContinuationFromProjectStatus, recordProjectStatusContinuationPrepared,
        materializeContextPackCycleFromWorkflowState, generatedContextPackSnapshotId,
        contextWorkPackageProviderExecutor, contextWorkPackageBackgroundLauncher,
        backgroundContextWorkPackageRequested, backgroundContextWorkPackageOutputPath,
        contextWorkPackageRunOptions, runContextWorkPackages, stageContextWorkPackageDispatch,
        createMainlineAlreadySatisfiedEvaluator, isSqliteSnapshotPath, sqliteSnapshotIdFromInputPath,
        stateDbPath, options,
        createWorkbenchLoopClient, workbenchBaseUrlFromRequest, createSchedulerLoopRunArtifact,
        recordAutonomousSchedulerLoopRunArtifact, buildSchedulerLoopRunRegistry,
        evaluateSchedulerLoopRecovery, recordSchedulerLoopResumeAttempt, executeProjectedNextAction
      };

      if (await handleWorkbenchBasicRoutes(routeContext)) {
        return;
      }

      if (await handleReviewerRoutes(routeContext)) {
        return;
      }

      if (await handleWorkflowEvidenceRoutes(routeContext)) {
        return;
      }

      if (await handleWorkbenchContextRoutes(routeContext)) {
        return;
      }

      if (await handleRequirementRoutes(routeContext)) {
        return;
      }

      if (await handleContextWorkPackageRoutes(routeContext)) {
        return;
      }

      if (await handleSchedulerDispatchRoutes(routeContext)) {
        return;
      }

      if (await handleSchedulerLoopRoutes(routeContext)) {
        return;
      }

      handleStaticRoute.handleFallback(url, res);
    } catch (error) {
      if (error.code === "ENOENT") {
        jsonResponse(res, 404, { error: "not found" });
        return;
      }

      if (error.code === "PROJECTION_NOT_FOUND") {
        jsonResponse(res, 404, { error: error.message });
        return;
      }

      if (error.code === "INVALID_HISTORY_PATH" || error.code === "WORKFLOW_SNAPSHOT_REQUIRED") {
        jsonResponse(res, 400, { error: error.message });
        return;
      }

      if (error.code === "INVALID_WORKBENCH_HOST") {
        jsonResponse(res, 400, { error: error.message });
        return;
      }

      if (error.code === "INVALID_CONTINUATION_PATH") {
        jsonResponse(res, 400, { error: error.message });
        return;
      }

      if (error.code === "INVALID_JSON_BODY") {
        jsonResponse(res, 400, { error: "invalid json" });
        return;
      }

      if (error.code === "REQUEST_BODY_TOO_LARGE") {
        jsonResponse(res, 413, {
          error: "request body too large",
          max_bytes: jsonBodyLimitBytes
        });
        return;
      }

      jsonResponse(res, 500, { error: error.message });
    }
  });

  const agentHealthIntervalMs = Number(options.agentHealthIntervalMs || options.agent_health_interval_ms || 10 * 60 * 1000);
  if (stateStore && agentHealthIntervalMs > 0 && options.disableAgentHealthTimer !== true) {
    const timer = setInterval(() => {
      runAgentHealthCheck(stateStore, {
        include_fresh: false,
        ttl_ms: agentHealthIntervalMs,
        checked_at: new Date().toISOString()
      }, {
        fetchImpl: options.agentHealthFetch || options.fetchImpl,
        accountHealthRunner: options.agentAccountHealthRunner,
        accountHealthCheckImpl: options.agentAccountHealthCheckImpl,
        manualAgentCliPath: options.manualAgentCliPath
      }).catch(() => {});
    }, agentHealthIntervalMs);
    timer.unref?.();
    server.on("close", () => clearInterval(timer));
  }

  return server;
}

export function startWorkbenchServer({
  port = 4180,
  host = "127.0.0.1",
  historyPath: configuredHistoryPath,
  snapshotsRoot: configuredSnapshotsRoot,
  eventsPath: configuredEventsPath,
  projectStatusPath,
  stateDbPath = defaultStateDbPath
} = {}) {
  const server = createWorkbenchServer({
    historyPath: configuredHistoryPath,
    snapshotsRoot: configuredSnapshotsRoot,
    eventsPath: configuredEventsPath,
    projectStatusPath,
    stateDbPath
  });
  const listenPort = normalizeCliPort(port);
  server.listen(listenPort, host);
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(workbenchServerHelpText());
    process.exit(0);
  }
  let cliOptions;
  try {
    cliOptions = parseWorkbenchServerCliArgs(process.argv.slice(2), process.env, { defaultStateDbPath });
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
  const server = startWorkbenchServer(cliOptions);
  server.on("listening", () => {
    const address = server.address();
    console.log(`Workbench server listening on http://${address.address}:${address.port}`);
  });
}
