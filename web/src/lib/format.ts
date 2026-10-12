export function bytes(count: number): string {
	if (count < 1024) return `${count} B`;
	if (count < 1024 * 1024) return `${(count / 1024).toFixed(1)} KB`;
	if (count < 1024 * 1024 * 1024) return `${(count / (1024 * 1024)).toFixed(1)} MB`;
	return `${(count / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** "2 min ago", "just now": the same shape on every card and in the Changes panel (6.2, 6.5). */
export function since(iso: string, now = Date.now()): string {
	const then = Date.parse(iso);
	if (!Number.isFinite(then)) return 'unknown';
	const seconds = Math.max(0, Math.round((now - then) / 1000));
	if (seconds < 45) return 'just now';
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes} min ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 36) return `${hours} h ago`;
	const days = Math.round(hours / 24);
	if (days < 30) return `${days} d ago`;
	return new Date(then).toLocaleDateString();
}

export function plural(count: number, one: string, many = `${one}s`): string {
	return `${count} ${count === 1 ? one : many}`;
}

export function objects(added: number, changed: number): string {
	const parts: string[] = [];
	if (added) parts.push(`${plural(added, 'new object')}`);
	if (changed) parts.push(`${plural(changed, 'changed object')}`);
	return parts.join(', ') || 'no new objects';
}
