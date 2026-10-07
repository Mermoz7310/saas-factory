export type Button = { label: string; data: string };

/** Canal de notification vers l'humain (Telegram en production, faux canal dans les tests). */
export interface Notifier {
  /** Renvoie l'identifiant du message envoyé, ou null si l'envoi est impossible. */
  send(text: string, buttons?: Button[][]): Promise<number | null>;
  /** Envoie un fichier texte (spec, migration, tests). */
  sendFile(name: string, content: string): Promise<void>;
}

export class NullNotifier implements Notifier {
  readonly sent: { text: string; buttons?: Button[][] }[] = [];
  readonly files: { name: string; content: string }[] = [];
  async sendFile(name: string, content: string): Promise<void> {
    this.files.push({ name, content });
  }
  async send(text: string, buttons?: Button[][]): Promise<number | null> {
    this.sent.push(buttons ? { text, buttons } : { text });
    return this.sent.length;
  }
}
