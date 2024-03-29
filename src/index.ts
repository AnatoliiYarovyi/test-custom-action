import { getInput, setOutput, setFailed, summary } from "@actions/core";
import type { Project, Deployment } from "@cloudflare/types";
import { context, getOctokit } from "@actions/github";
import { fetch } from "undici";
import { env } from "process";

type Octokit = ReturnType<typeof getOctokit>;

const apiToken =
	"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiJlOGE4Y2VkZS04NjE3LTRjZmYtOTA5Ny0wNjYxODNjNDUzYmYiLCJleHBpcmVzIjoiMjAyNC0wOS0xMlQxODoxNjoxNi40MzRaIn0.8tmIRzWeDo43-Fj1WZFCVTRw7yLkds0zNxadmAv-Gx4";

try {
	const projectName = getInput("projectName", { required: true });
	const directory = getInput("directory", { required: true });
	const gitHubToken = getInput("gitHubToken", { required: false });
	const branch = getInput("branch", { required: false });
	// const workingDirectory = getInput("workingDirectory", { required: false });
	// const wranglerVersion = getInput("wranglerVersion", { required: false });

	const getProject = async () => {
		const response = await fetch(`https://hobbit-db-be.fly.dev/pages/cf/projects/${projectName}`, {
			headers: { Authorization: `Bearer ${apiToken}` },
		});

		if (!response.ok) {
			throw new Error("Failed to fetch project data");
		}

		const projectData = await response.json();
		return projectData as Project;
	};

	const createPagesDeployment = async () => {
		const response = await fetch(
			`https://hobbit-db-be.fly.dev/pages/cf/deployments/${projectName}/${directory}/${branch}`,
			{
				headers: { Authorization: `Bearer ${apiToken}` },
			},
		);

		if (!response.ok) {
			throw new Error("Failed to fetch deployment data");
		}

		const deploymentData = await response.json();
		return deploymentData as Deployment;
	};

	const githubBranch = env.GITHUB_HEAD_REF || env.GITHUB_REF_NAME;

	const createGitHubDeployment = async (octokit: Octokit, productionEnvironment: boolean, environment: string) => {
		const deployment = await octokit.rest.repos.createDeployment({
			owner: context.repo.owner,
			repo: context.repo.repo,
			ref: githubBranch || context.ref,
			auto_merge: false,
			description: "Cloudflare Pages",
			required_contexts: [],
			environment,
			production_environment: productionEnvironment,
		});

		if (deployment.status === 201) {
			return deployment.data;
		}
	};

	const createGitHubDeploymentStatus = async ({
		id,
		url,
		deploymentId,
		environmentName,
		productionEnvironment,
		octokit,
	}: {
		octokit: Octokit;
		id: number;
		url: string;
		deploymentId: string;
		environmentName: string;
		productionEnvironment: boolean;
	}) => {
		await octokit.rest.repos.createDeploymentStatus({
			owner: context.repo.owner,
			repo: context.repo.repo,
			deployment_id: id,
			// @ts-ignore
			environment: environmentName,
			environment_url: url,
			production_environment: productionEnvironment,
			// log_url: `https://dash.cloudflare.com/${accountId}/pages/view/${projectName}/${deploymentId}`,
			description: "Cloudflare Pages",
			state: "success",
			auto_inactive: false,
		});
	};

	const createJobSummary = async ({ deployment, aliasUrl }: { deployment: Deployment; aliasUrl: string }) => {
		const deployStage = deployment.stages.find((stage) => stage.name === "deploy");

		let status = "⚡️  Deployment in progress...";
		console.log("==================================");
		console.log("deployStage?.status: ", deployStage?.status);
		console.log("==================================");

		if (deployStage?.status === "success") {
			status = "✅  Deploy successful!";
		} else if (deployStage?.status === "failure") {
			status = "🚫  Deployment failed";
		}

		await summary
			.addRaw(
				`
# Deploying with Cloudflare Pages

| Name                    | Result |
| ----------------------- | - |
| **Last commit:**        | \`${deployment.deployment_trigger.metadata.commit_hash.substring(0, 8)}\` |
| **Status**:             | ${status} |
| **Preview URL**:        | ${deployment.url} |
| **Branch Preview URL**: | ${aliasUrl} |
      `,
			)
			.write();
	};

	(async () => {
		const project = await getProject();

		const productionEnvironment = githubBranch === project.production_branch || branch === project.production_branch;
		const environmentName = `${projectName} (${productionEnvironment ? "Production" : "Preview"})`;

		let gitHubDeployment: Awaited<ReturnType<typeof createGitHubDeployment>>;

		if (gitHubToken && gitHubToken.length) {
			const octokit = getOctokit(gitHubToken);
			gitHubDeployment = await createGitHubDeployment(octokit, productionEnvironment, environmentName);
		}

		const pagesDeployment = await createPagesDeployment();
		setOutput("id", pagesDeployment.id);
		setOutput("url", pagesDeployment.url);
		setOutput("environment", pagesDeployment.environment);

		let alias = pagesDeployment.url;
		if (!productionEnvironment && pagesDeployment.aliases && pagesDeployment.aliases.length > 0) {
			alias = pagesDeployment.aliases[0];
		}
		setOutput("alias", alias);

		await createJobSummary({ deployment: pagesDeployment, aliasUrl: alias });

		if (gitHubDeployment) {
			const octokit = getOctokit(gitHubToken);

			await createGitHubDeploymentStatus({
				id: gitHubDeployment.id,
				url: pagesDeployment.url,
				deploymentId: pagesDeployment.id,
				environmentName,
				productionEnvironment,
				octokit,
			});
		}
	})();
} catch (thrown: any) {
	setFailed(thrown.message);
}
