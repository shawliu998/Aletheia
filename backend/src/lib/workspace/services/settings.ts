import { UpdateWorkspaceSettingsRequestSchema } from "../contracts";
import { ModelProfilesRepository } from "../repositories/modelProfiles";
import { ProjectsRepository } from "../repositories/projects";
import { SettingsRepository } from "../repositories/settings";
export class SettingsService {
  constructor(
    private readonly settings: SettingsRepository,
    private readonly projects: ProjectsRepository,
    private readonly profiles: ModelProfilesRepository,
    private readonly clock: () => Date = () => new Date(),
  ) {}
  get() {
    return this.settings.get();
  }
  update(value: unknown) {
    const v = UpdateWorkspaceSettingsRequestSchema.parse(value);
    return this.settings.update({ ...v, now: this.clock().toISOString() });
  }
}
