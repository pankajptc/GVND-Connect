import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.gvnd.connect',
  appName: 'GVND Connect',
  webDir: '.output/public',
  server: {
    androidScheme: 'https',
    cleartext: true,
  },
};

export default config;
