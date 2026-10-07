export type Button = { label: string; data: string };

/** Canal de notification vers l'humain (Telegram en production, faux canal dans les tests). */
export interface Notifier {
  /** Renvoie l'identifiant du message envoyé, ou null si l'envoi est impossible. */
  send(text: string, buttons?: Button[][]): Promise<number | null>;
}

export class NullNotifier implements Notifier {
  readonly sent: { text: string; buttons?: Button[][] }[] = [];
  async send(text: string, buttons?: Button[][]): Promise<number | null> {
    this.sent.push(buttons ? { text, buttons } : { text });
    return this.sent.length;
  }
}
