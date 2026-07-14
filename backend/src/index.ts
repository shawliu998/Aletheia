import "dotenv/config";
import {
  bootstrapVeraApplication,
  type VeraApplicationInstance,
} from "./veraApplication";

export function registerVeraProcessSignals(
  application: VeraApplicationInstance,
): () => void {
  let requested = false;
  const requestShutdown = () => {
    if (requested) return;
    requested = true;
    void application.shutdown().catch(() => {
      console.error("[vera-shutdown] failed");
      process.exitCode = 1;
    });
  };

  process.once("SIGINT", requestShutdown);
  process.once("SIGTERM", requestShutdown);
  return () => {
    process.off("SIGINT", requestShutdown);
    process.off("SIGTERM", requestShutdown);
  };
}

export async function main(): Promise<VeraApplicationInstance> {
  const application = await bootstrapVeraApplication();
  registerVeraProcessSignals(application);
  console.log(
    `Vera backend running at http://${application.host}:${application.port}`,
  );
  return application;
}

if (require.main === module) {
  void main().catch(() => {
    console.error("[vera-startup] failed");
    process.exitCode = 1;
  });
}
