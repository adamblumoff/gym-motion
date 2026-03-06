import { DeviceDashboard } from "@/components/device-dashboard";

import styles from "./page.module.css";

export default function Home() {
  return (
    <main className={styles.page}>
      <div className={styles.shell}>
        <div className={styles.eyebrow}>ESP32 Motion Monitor</div>
        <h1 className={styles.title}>Moving or Still.</h1>
        <p className={styles.subtitle}>
          The dashboard polls the latest state for every device and makes the
          current motion status obvious at a glance.
        </p>
        <DeviceDashboard />
      </div>
    </main>
  );
}
