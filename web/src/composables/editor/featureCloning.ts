import type { EditorFeature, ProjectEnvelope } from './types'

/**
 * High-performance cloning helper that copies mutable feature attributes (properties, profiles, overrides, metadata)
 * while preserving references to large immutable coordinate arrays (`sourceGeometry`, `effectiveGeometry`),
 * avoiding expensive deep reactive overhead and deep allocations during edits and snapshots.
 */

export function cloneFeature(f: EditorFeature): EditorFeature {
  const cloned: EditorFeature = {
    ...f,
    // Preserve geometry references directly (coordinates are immutable in editor sessions)
    sourceGeometry: f.sourceGeometry,
    effectiveGeometry: f.effectiveGeometry,
    // Shallow/structured clone mutable metadata & profiles
    properties: { ...f.properties },
    sourceTags: f.sourceTags ? { ...f.sourceTags } : undefined,
    roadProfile: f.roadProfile
      ? {
          ...f.roadProfile,
          carriagewayWidthMeters: f.roadProfile.carriagewayWidthMeters
            ? { ...f.roadProfile.carriagewayWidthMeters }
            : undefined,
          roadwayWidthMeters: f.roadProfile.roadwayWidthMeters
            ? { ...f.roadProfile.roadwayWidthMeters }
            : undefined,
          totalCorridorWidth: f.roadProfile.totalCorridorWidth
            ? { ...f.roadProfile.totalCorridorWidth }
            : undefined,
          lanes: f.roadProfile.lanes ? { ...f.roadProfile.lanes } : undefined,
          forwardLanes: f.roadProfile.forwardLanes ? { ...f.roadProfile.forwardLanes } : undefined,
          backwardLanes: f.roadProfile.backwardLanes ? { ...f.roadProfile.backwardLanes } : undefined,
          speedLimit: f.roadProfile.speedLimit ? { ...f.roadProfile.speedLimit } : undefined,
          surface: f.roadProfile.surface ? { ...f.roadProfile.surface } : undefined,
          sidewalks: f.roadProfile.sidewalks
            ? {
                ...f.roadProfile.sidewalks,
                details: f.roadProfile.sidewalks.details
                  ? { ...f.roadProfile.sidewalks.details }
                  : undefined
              }
            : undefined,
          cycleFacilities: f.roadProfile.cycleFacilities
            ? {
                ...f.roadProfile.cycleFacilities,
                details: f.roadProfile.cycleFacilities.details
                  ? { ...f.roadProfile.cycleFacilities.details }
                  : undefined
              }
            : undefined,
          strips: f.roadProfile.strips ? f.roadProfile.strips.map((s) => ({ ...s })) : [],
          direction: f.roadProfile.direction,
          profileFlags: f.roadProfile.profileFlags ? [...f.roadProfile.profileFlags] : undefined,
          associatedSeparateFacilities: f.roadProfile.associatedSeparateFacilities
            ? f.roadProfile.associatedSeparateFacilities.map((a) => ({ ...a }))
            : undefined
        }
      : undefined,
    buildingProfile: f.buildingProfile
      ? {
          ...f.buildingProfile,
          heightMeters: f.buildingProfile.heightMeters ? { ...f.buildingProfile.heightMeters } : undefined,
          levels: f.buildingProfile.levels ? { ...f.buildingProfile.levels } : undefined,
          surface: f.buildingProfile.surface ? { ...f.buildingProfile.surface } : undefined,
          footprintAreaSquareMeters: f.buildingProfile.footprintAreaSquareMeters
            ? { ...f.buildingProfile.footprintAreaSquareMeters }
            : undefined
        }
      : undefined,
    inferred: f.inferred ? { ...f.inferred } : { width: false, sidewalk: false, bikeLane: false },
    warnings: f.warnings ? [...f.warnings] : undefined,
    sourceReferences: f.sourceReferences ? [...f.sourceReferences] : undefined,
    associatedFacilityIds: f.associatedFacilityIds ? [...f.associatedFacilityIds] : undefined,
    associatedSeparateFacilities: f.associatedSeparateFacilities
      ? f.associatedSeparateFacilities.map((a) => ({ ...a }))
      : undefined
  }
  return cloned
}

export function cloneFeatureCollection(features: EditorFeature[]): EditorFeature[] {
  return features.map((f) => cloneFeature(f))
}

export function cloneProjectEnvelope(env: ProjectEnvelope): ProjectEnvelope {
  return {
    schemaVersion: env.schemaVersion,
    sourceMetadata: {
      ...env.sourceMetadata,
      bbox: env.sourceMetadata?.bbox ? [...env.sourceMetadata.bbox] : undefined,
      sourceAttributions: env.sourceMetadata?.sourceAttributions
        ? env.sourceMetadata.sourceAttributions.map((a) => ({ ...a }))
        : undefined,
      licenses: env.sourceMetadata?.licenses ? [...env.sourceMetadata.licenses] : undefined
    },
    projectionOrigin: { ...env.projectionOrigin },
    selectedBounds: env.selectedBounds ? [...env.selectedBounds] : undefined,
    projection: env.projection ? { ...env.projection, origin: { ...env.projection.origin } } : undefined,
    sourceFeatures: env.sourceFeatures ? cloneFeatureCollection(env.sourceFeatures) : undefined,
    features: cloneFeatureCollection(env.features),
    editOverrides: env.editOverrides ? JSON.parse(JSON.stringify(env.editOverrides)) : {},
    editorSettings: env.editorSettings
      ? {
          ...env.editorSettings,
          layerVisibility: env.editorSettings.layerVisibility ? { ...env.editorSettings.layerVisibility } : undefined,
          exportInclusions: env.editorSettings.exportInclusions ? { ...env.editorSettings.exportInclusions } : undefined,
          clippingPolicy: env.editorSettings.clippingPolicy ? { ...env.editorSettings.clippingPolicy } : undefined
        }
      : undefined,
    warnings: env.warnings ? [...env.warnings] : undefined
  }
}
