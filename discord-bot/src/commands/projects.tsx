import React, { useState } from "react";
import {
  Embed,
  EmbedField,
  EmbedTitle,
  EmbedFooter,
  Button,
  ActionRow,
} from "@answeroverflow/discordjs-react";
import {
  listProjects,
  listProjectTasks,
  getProjectTaskCounts,
  claimTask,
  CommunityProject,
  ProjectTask,
} from "../db.js";

// ── Colors ─────────────────────────────────────────────────────────────────

const COLOR_VOTING   = 0x5865f2; // blurple
const COLOR_ACTIVE   = 0x2ecc71; // green
const COLOR_CLOSED   = 0x95a5a6; // grey
const COLOR_TASKS    = 0xeb459e; // pink
const COLOR_ERROR    = 0xe74c3c; // red
const COLOR_SUCCESS  = 0x2ecc71; // green

// ── Helpers ────────────────────────────────────────────────────────────────

function projectColor(status: string): number {
  if (status === "active")  return COLOR_ACTIVE;
  if (status === "voting")  return COLOR_VOTING;
  return COLOR_CLOSED;
}

function statusBadge(status: string): string {
  const badges: Record<string, string> = {
    voting:   "🗳️ **VOTING**",
    active:   "🟢 **ACTIVE**",
    rejected: "🔴 **REJECTED**",
    cooldown: "⏳ **COOLDOWN**",
  };
  return badges[status] ?? `❓ **${status.toUpperCase()}**`;
}

function taskProgressBar(
  open: number,
  claimed: number,
  done: number,
  blocks = 8
): string {
  const total = open + claimed + done;
  if (total === 0) return "⬜".repeat(blocks) + " 0/0 tasks";
  const filledDone    = Math.floor((done    / total) * blocks);
  const filledClaimed = Math.floor((claimed / total) * blocks);
  const filledOpen    = blocks - filledDone - filledClaimed;
  return (
    "🟩".repeat(filledDone) +
    "🟡".repeat(filledClaimed) +
    "⬜".repeat(Math.max(0, filledOpen)) +
    ` **${claimed + done}/${total}** claimed (${done} done)`
  );
}

function truncate(str: string | null, max: number): string {
  if (!str) return "_No description_";
  return str.length > max ? str.slice(0, max - 1) + "…" : str;
}

// ── Projects List Embed ────────────────────────────────────────────────────

function ProjectListEmbed({ projects }: { projects: CommunityProject[] }) {
  if (projects.length === 0) {
    return (
      <Embed color={COLOR_VOTING}>
        <EmbedTitle>📋 Community Projects</EmbedTitle>
        <EmbedField
          name="😶 No Active Projects"
          value="No community projects found. Use `/proposeproject` to kick one off!"
          inline={false}
        />
        <EmbedFooter text="Community-driven development · Propose something great" />
      </Embed>
    );
  }

  // Group by status for visual clarity
  const active   = projects.filter((p) => p.status === "active");
  const voting   = projects.filter((p) => p.status === "voting");
  const other    = projects.filter((p) => p.status !== "active" && p.status !== "voting");

  const embedColor =
    active.length > 0  ? COLOR_ACTIVE :
    voting.length > 0  ? COLOR_VOTING : COLOR_CLOSED;

  const statLine = `🟢 **${active.length}** active · 🗳️ **${voting.length}** voting · 🔴 **${other.length}** closed`;

  return (
    <Embed color={embedColor}>
      <EmbedTitle>📋 Community Projects</EmbedTitle>

      <EmbedField
        name="📊 Project Status"
        value={statLine}
        inline={false}
      />

      <EmbedField name="\u200b" value="\u200b" inline={false} />

      {projects.map((p) => {
        const counts = getProjectTaskCounts(p.id);
        const taskTotal = counts.open + counts.claimed + counts.done;
        const taskBar = taskProgressBar(counts.open, counts.claimed, counts.done, 8);
        const taskLine = taskTotal > 0
          ? `Tasks: ${taskBar}`
          : "_No tasks yet_";
        const repoLine = p.repo_url ? `\n🔗 [View Repo](${p.repo_url})` : "";

        return (
          <EmbedField
            key={p.id}
            name={`${statusBadge(p.status)} · ${p.title} *(#${p.id})*`}
            value={truncate(p.description, 120) + repoLine + "\n" + taskLine}
            inline={false}
          />
        );
      })}

      <EmbedFooter text="Click a project button below to view & claim tasks" />
    </Embed>
  );
}

// ── Task List Embed ────────────────────────────────────────────────────────

function TaskListEmbed({
  project,
  tasks,
  claimerId,
  claimResult,
}: {
  project: CommunityProject;
  tasks: ProjectTask[];
  claimerId: string;
  claimResult: string | null;
}) {
  const openTasks  = tasks.filter((t) => t.status === "open");
  const claimed    = tasks.filter((t) => t.status === "claimed");
  const done       = tasks.filter((t) => t.status === "done");

  const taskBar = taskProgressBar(openTasks.length, claimed.length, done.length, 8);

  return (
    <Embed color={COLOR_TASKS}>
      <EmbedTitle>
        📌 Tasks — {project.title}
      </EmbedTitle>

      {/* Project header */}
      <EmbedField
        name={`${statusBadge(project.status)} · Project #${project.id}`}
        value={
          truncate(project.description, 100) +
          (project.repo_url ? `\n🔗 [Repo](${project.repo_url})` : "")
        }
        inline={false}
      />

      {/* Task progress bar */}
      <EmbedField
        name="📊 Task Progress"
        value={`Tasks: ${taskBar}`}
        inline={false}
      />

      {/* Claim result banner */}
      {claimResult && (
        <EmbedField
          name="📢 Result"
          value={claimResult}
          inline={false}
        />
      )}

      <EmbedField name="\u200b" value="\u200b" inline={false} />

      {/* Open tasks */}
      {openTasks.length > 0 ? (
        openTasks.map((t) => (
          <EmbedField
            key={`open-${t.id}`}
            name={`🟢 #${t.id} ${t.title} — ${t.points} pts`}
            value={truncate(t.description, 100) + "\n_Unclaimed — tap button below to grab it_"}
            inline={false}
          />
        ))
      ) : (
        <EmbedField
          name="✅ All Tasks Claimed or Done"
          value="_No open tasks available_"
          inline={false}
        />
      )}

      {/* Claimed / done */}
      {(claimed.length > 0 || done.length > 0) && (
        <EmbedField
          name="📋 Claimed & Done"
          value={[...claimed, ...done]
            .map((t) => {
              const icon = t.status === "done" ? "✅" : "🟡";
              const who = t.claimed_by ? `<@${t.claimed_by}>` : "_Unclaimed_";
              return `${icon} **#${t.id} ${t.title}** (${t.points} pts) — ${who}`;
            })
            .join("\n")}
          inline={false}
        />
      )}

      <EmbedFooter
        text={`Project #${project.id} · ${openTasks.length} open · ${claimed.length} claimed · ${done.length} done`}
      />
    </Embed>
  );
}

// ── Main Component ─────────────────────────────────────────────────────────

export function ProjectsDashboard({ discordId }: { discordId: string }) {
  const [view, setView]                   = useState<"list" | "tasks">("list");
  const [selectedProjectId, setSelectedProjectId] = useState<number | null>(null);
  const [claimResult, setClaimResult]     = useState<string | null>(null);
  const [taskNonce, setTaskNonce]         = useState(0);

  const projects = listProjects();

  // ── List view ──
  if (view === "list" || selectedProjectId === null) {
    const projectButtons =
      projects.length > 0
        ? projects.slice(0, 5).map((p) => (
            <Button
              key={p.id}
              label={`📂 ${p.title.slice(0, 20)}`}
              style={p.status === "active" ? "Success" : p.status === "voting" ? "Primary" : "Secondary"}
              onClick={() => {
                setSelectedProjectId(p.id);
                setClaimResult(null);
                setView("tasks");
              }}
            />
          ))
        : [];

    return (
      <>
        <ProjectListEmbed projects={projects} />
        {projectButtons.length > 0 && <ActionRow>{projectButtons}</ActionRow>}
      </>
    );
  }

  // ── Task view ──
  const project = projects.find((p) => p.id === selectedProjectId);
  if (!project) {
    return (
      <Embed color={COLOR_ERROR}>
        <EmbedTitle>❌ Project Not Found</EmbedTitle>
        <EmbedField
          name="Error"
          value="Could not load this project — it may have been removed."
          inline={false}
        />
      </Embed>
    );
  }

  const tasks     = listProjectTasks(selectedProjectId);
  const openTasks = tasks.filter((t) => t.status === "open");

  const claimButtons = openTasks.slice(0, 4).map((t) => (
    <Button
      key={t.id}
      label={`Claim #${t.id}`}
      style="Success"
      onClick={() => {
        const result = claimTask(t.id, discordId);
        if (result.ok) {
          setClaimResult(`✅ You claimed task **#${t.id}: ${t.title}**! (+${t.points} pts)`);
        } else {
          setClaimResult(`❌ Could not claim: ${result.reason}`);
        }
        setTaskNonce((n) => n + 1);
      }}
    />
  ));

  return (
    <>
      <TaskListEmbed
        project={project}
        tasks={tasks}
        claimerId={discordId}
        claimResult={claimResult}
        key={taskNonce}
      />
      <ActionRow>
        <Button
          label="◀ Projects"
          style="Primary"
          onClick={() => {
            setView("list");
            setSelectedProjectId(null);
            setClaimResult(null);
          }}
        />
        {claimButtons}
      </ActionRow>
    </>
  );
}
