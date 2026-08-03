import { latestPerSystem } from '../lib/fleet-query.js'
import { FleetTable } from '../components/FleetTable.js'

export const dynamic = 'force-dynamic'

export default async function Page() {
  const { rows, lastExternalSweep } = await latestPerSystem(new Date())
  return (
    <main>
      <h1>Fleet</h1>
      <FleetTable rows={rows} lastExternalSweep={lastExternalSweep} />
    </main>
  )
}
