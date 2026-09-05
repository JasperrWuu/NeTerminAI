/** Project context is Core-owned state exposed to AI through a narrow adapter. */
export interface ProjectContext {
  goal: string;
  topology: string;
  keyConfigurations: string[];
  confirmedFacts: string[];
  progress: string;
  issues: string[];
  conclusions: string[];
  nextSteps: string[];
  updatedAt: number;
}

export type ProjectContextPatch = Partial<Omit<ProjectContext, "updatedAt">>;

export interface ProjectContextCapability {
  get(): ProjectContext | undefined;
  update(patch: ProjectContextPatch): void;
}
