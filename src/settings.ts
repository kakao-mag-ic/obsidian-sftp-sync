import { App, PluginSettingTab, Setting } from "obsidian";
import type SftpSyncPlugin from "./main";
import { testSshConnection } from "./remote";

export class SftpSyncSettingTab extends PluginSettingTab {
  plugin: SftpSyncPlugin;

  constructor(app: App, plugin: SftpSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    // --- Connection ---
    containerEl.createEl("h2", { text: "Connection" });

    new Setting(containerEl)
      .setName("Host")
      .setDesc("SFTP server hostname")
      .addText((text) =>
        text
          .setPlaceholder("example.com")
          .setValue(this.plugin.settings.host)
          .onChange(async (value) => {
            this.plugin.settings.host = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Port")
      .setDesc("SFTP server port")
      .addText((text) =>
        text
          .setPlaceholder("22")
          .setValue(String(this.plugin.settings.port))
          .onChange(async (value) => {
            this.plugin.settings.port = parseInt(value) || 22;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Username")
      .addText((text) =>
        text
          .setPlaceholder("user")
          .setValue(this.plugin.settings.username)
          .onChange(async (value) => {
            this.plugin.settings.username = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Private key (PEM)")
      .setDesc("Paste your SSH private key here. It will be stored base64-encoded in the plugin data file.")
      .addTextArea((text) =>
        text
          .setPlaceholder("-----BEGIN OPENSSH PRIVATE KEY-----\n...")
          .setValue(
            this.plugin.settings.privateKey
              ? Buffer.from(this.plugin.settings.privateKey, "base64").toString("utf-8")
              : ""
          )
          .onChange(async (value) => {
            this.plugin.settings.privateKey = value
              ? Buffer.from(value).toString("base64")
              : "";
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Private key path")
      .setDesc("Or specify the path to your SSH key file (e.g. ~/.ssh/id_rsa)")
      .addText((text) =>
        text
          .setPlaceholder("/home/user/.ssh/id_rsa")
          .setValue(this.plugin.settings.privateKeyPath)
          .onChange(async (value) => {
            this.plugin.settings.privateKeyPath = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Passphrase")
      .setDesc("Key passphrase (if applicable)")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("passphrase")
          .setValue(this.plugin.settings.passphrase)
          .onChange(async (value) => {
            this.plugin.settings.passphrase = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Test connection")
      .setDesc("Verify that the connection settings work")
      .addButton((button) =>
        button.setButtonText("Test").onClick(async () => {
          button.setButtonText("Testing...");
          button.setDisabled(true);
          const result = await testSshConnection(this.plugin.settings);
          button.setButtonText(result.ok ? "Success!" : "Failed");
          button.setDisabled(false);
          setTimeout(() => button.setButtonText("Test"), 3000);
        })
      );

    // --- Remote Path ---
    containerEl.createEl("h2", { text: "Remote Path" });

    new Setting(containerEl)
      .setName("Remote path")
      .setDesc("Absolute path on the remote server to sync with")
      .addText((text) =>
        text
          .setPlaceholder("/path/to/remote/dir")
          .setValue(this.plugin.settings.remotePath)
          .onChange(async (value) => {
            this.plugin.settings.remotePath = value;
            await this.plugin.saveSettings();
          })
      );

    // --- Sync ---
    containerEl.createEl("h2", { text: "Sync" });

    new Setting(containerEl)
      .setName("Auto sync interval (seconds)")
      .setDesc("How often to automatically sync. Set to 0 to disable.")
      .addText((text) =>
        text
          .setPlaceholder("180")
          .setValue(String(this.plugin.settings.autoSyncIntervalSec))
          .onChange(async (value) => {
            this.plugin.settings.autoSyncIntervalSec = parseInt(value) || 0;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Sync on startup")
      .setDesc("Run sync when Obsidian starts")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.syncOnStartup)
          .onChange(async (value) => {
            this.plugin.settings.syncOnStartup = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Sync direction")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("bidirectional", "Bidirectional")
          .addOption("pull_only", "Pull only (remote → local)")
          .addOption("push_only", "Push only (local → remote)")
          .setValue(this.plugin.settings.syncDirection)
          .onChange(async (value: any) => {
            this.plugin.settings.syncDirection = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Conflict strategy")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("newer_wins", "Newer wins")
          .addOption("larger_wins", "Larger wins")
          .addOption("local_wins", "Local wins")
          .addOption("remote_wins", "Remote wins")
          .setValue(this.plugin.settings.conflictStrategy)
          .onChange(async (value: any) => {
            this.plugin.settings.conflictStrategy = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Delete sync")
      .setDesc("Sync file deletions. When off, deleted files are restored from the other side.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.deleteSync)
          .onChange(async (value) => {
            this.plugin.settings.deleteSync = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Push debounce (seconds)")
      .setDesc("Wait this long after a local change before pushing to server.")
      .addText((text) =>
        text
          .setPlaceholder("5")
          .setValue(String(this.plugin.settings.pushDebounceSec))
          .onChange(async (value) => {
            this.plugin.settings.pushDebounceSec = parseInt(value) || 5;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Pull interval (seconds)")
      .setDesc("How often to check server for changes.")
      .addText((text) =>
        text
          .setPlaceholder("30")
          .setValue(String(this.plugin.settings.pullIntervalSec))
          .onChange(async (value) => {
            this.plugin.settings.pullIntervalSec = parseInt(value) || 30;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Max file size (MB)")
      .setDesc("Skip files larger than this size. Set to 0 to disable.")
      .addText((text) =>
        text
          .setPlaceholder("100")
          .setValue(String(this.plugin.settings.maxFileSizeMB))
          .onChange(async (value) => {
            this.plugin.settings.maxFileSizeMB = parseInt(value) || 0;
            await this.plugin.saveSettings();
          })
      );

    // --- Filter ---
    containerEl.createEl("h2", { text: "Filter" });

    new Setting(containerEl)
      .setName("Ignore paths")
      .setDesc("Paths/patterns to ignore (one per line)")
      .addTextArea((text) =>
        text
          .setPlaceholder(".obsidian\n.git\nnode_modules")
          .setValue(this.plugin.settings.ignorePaths.join("\n"))
          .onChange(async (value) => {
            this.plugin.settings.ignorePaths = value
              .split("\n")
              .map((s) => s.trim())
              .filter((s) => s.length > 0);
            await this.plugin.saveSettings();
          })
      );

    // --- Advanced ---
    containerEl.createEl("h2", { text: "Advanced" });

    new Setting(containerEl)
      .setName("Connection timeout (ms)")
      .addText((text) =>
        text
          .setPlaceholder("5000")
          .setValue(String(this.plugin.settings.connectTimeoutMs))
          .onChange(async (value) => {
            this.plugin.settings.connectTimeoutMs = parseInt(value) || 5000;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Max retries")
      .addText((text) =>
        text
          .setPlaceholder("2")
          .setValue(String(this.plugin.settings.maxRetries))
          .onChange(async (value) => {
            this.plugin.settings.maxRetries = parseInt(value) || 2;
            await this.plugin.saveSettings();
          })
      );
  }
}
