import { useCopy } from './lib/copy'

export default function NotFound() {
  const { t } = useCopy()
  return (
    <div className="container" style={{ textAlign: 'center', paddingTop: '20vh' }}>
      <h1 style={{ fontSize: '4rem', fontWeight: 700, color: 'var(--text-muted)' }}>404</h1>
      <p className="subtitle" style={{ fontSize: '1.1rem' }}>
        {t.notFound.title}
      </p>
      <a href="/" style={{ color: 'var(--accent)', marginTop: '16px', display: 'inline-block' }}>
        {t.notFound.home}
      </a>
    </div>
  )
}
