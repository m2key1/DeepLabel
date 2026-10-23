import type { Group, Job } from '../../api'

/** Every dataset in the group the caller can reach - what a group-wide action changes,
 *  whatever the list in front of them is filtered to. */
export function groupSize(group: Group, jobs: Job[]): number {
  return group.count ?? jobs.filter((j) => j.group_id === group.id).length
}
