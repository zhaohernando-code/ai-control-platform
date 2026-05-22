function contextWorkPackagesRunArtifactIdFrom(artifacts = []) {
  return [...artifacts]
    .reverse()
    .find((artifact) => artifact?.metadata?.type === "context_work_packages_run")
    ?.id || null;
}

export function withProviderAttemptsInRunArtifact(runArtifact, providerAttempts = []) {
  if (!runArtifact) return runArtifact;
  return {
    ...runArtifact,
    metadata: {
      ...(runArtifact.metadata || {}),
      executor_provenance: {
        ...(runArtifact.metadata?.executor_provenance || {}),
        provider_attempts: providerAttempts
      }
    }
  };
}

export function latestContextWorkPackagesRunArtifactId(workflowState = {}) {
  const manifestArtifacts = Array.isArray(workflowState.manifest?.artifacts)
    ? workflowState.manifest.artifacts
    : [];
  const ledgerArtifacts = Array.isArray(workflowState.artifact_ledger?.artifacts)
    ? workflowState.artifact_ledger.artifacts
    : [];

  return contextWorkPackagesRunArtifactIdFrom(manifestArtifacts) ||
    contextWorkPackagesRunArtifactIdFrom(ledgerArtifacts);
}

export function withProviderAttemptsInWorkflowState(workflowState, providerAttempts = []) {
  if (!workflowState) return workflowState;
  const artifactId = latestContextWorkPackagesRunArtifactId(workflowState);
  if (!artifactId) return workflowState;
  const updateArtifact = (artifact) => artifact?.id === artifactId
    ? withProviderAttemptsInRunArtifact(artifact, providerAttempts)
    : artifact;

  return {
    ...workflowState,
    manifest: {
      ...(workflowState.manifest || {}),
      artifacts: Array.isArray(workflowState.manifest?.artifacts)
        ? workflowState.manifest.artifacts.map(updateArtifact)
        : workflowState.manifest?.artifacts
    },
    artifact_ledger: {
      ...(workflowState.artifact_ledger || {}),
      artifacts: Array.isArray(workflowState.artifact_ledger?.artifacts)
        ? workflowState.artifact_ledger.artifacts.map(updateArtifact)
        : workflowState.artifact_ledger?.artifacts
    }
  };
}
