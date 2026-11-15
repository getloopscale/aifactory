import { useCopy } from './lib/copy'

export default function ErrorPage() {
  const { t } = useCopy()
  return (
    <div className="container" style={{ textAlign: 'center', paddingTop: '20vh' }}>
      <h1 style={{ fontSize: '2rem', marginBottom: '12px' }}>{t.errorPage.title}</h1>
      <p className="subtitle">{t.errorPage.message}</p>
      <a href="/" style={{ color: 'var(--accent)', marginTop: '16px', display: 'inline-block' }}>
        {t.errorPage.home}
      </a>
    </div>
  )
}
