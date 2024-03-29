import { getInput, setOutput, setFailed, summary } from "@actions/core";
import type { Project, Deployment } from "@cloudflare/types";
import { context, getOctokit } from "@actions/github";
import { fetch } from "undici";
import { env } from "process";
import path from "node:path";
import fs from "fs";
import archiver from "archiver";
import FormData from "form-data";
import axios from "axios";

type Octokit = ReturnType<typeof getOctokit>;

export interface IResponsePagesData {
	items: IResponsePagesItem[];
}
export interface IResponsePagesItem {
	id: string;
	name: string;
	createdAt: Date;
}
export interface IResponsePagesCreate {
	id: string;
}

try {
	const projectName = getInput("projectName", { required: true });
	const directory = getInput("directory", { required: true });
	const unexpectedToken = getInput("unexpectedToken", { required: true });
	const gitHubToken = getInput("gitHubToken", { required: false });
	const branch = getInput("branch", { required: false });
	const workingDirectory = getInput("workingDirectory", { required: false });

	const getProjectId = async (): Promise<string> => {
		const responsePages = await axios.get(`https://hobbit-db-be.fly.dev/pages`, {
			headers: { Authorization: `Bearer ${unexpectedToken}` },
		});
		const responsePagesData = responsePages.data as IResponsePagesData;

		const responseProjectData = responsePagesData.items.find((el) => el.name === projectName);

		if (!responseProjectData || !responseProjectData.id) {
			const response = await axios.post(
				`https://hobbit-db-be.fly.dev/pages`,
				{ name: projectName },
				{
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${unexpectedToken}`,
					},
				},
			);

			const qData = response.data as IResponsePagesCreate;
			if (response.status !== 200) {
				throw new Error("Project name not available");
			}

			return qData.id;
		}

		return responseProjectData.id;
	};

	const getProject = async () => {
		const projectId = await getProjectId();

		const response = await axios.get(`https://hobbit-db-be.fly.dev/pages/cf/projects/${projectName}`, {
			headers: { Authorization: `Bearer ${unexpectedToken}` },
		});

		if (response.status !== 200) {
			throw new Error("Failed to fetch project data");
		}

		const projectData = response.data as Project;
		return { project: projectData, projectId };
	};

	const createPagesDeployment = async (projectId: string) => {
		const filePath = path.join(process.cwd(), workingDirectory, directory);
		const output = fs.createWriteStream(`${filePath}.zip`);
		const archive = archiver("zip");

		archive.pipe(output);
		archive.directory(filePath, false);

		await new Promise((resolve, reject) => {
			output.on("close", resolve);
			output.on("error", reject);
			archive.finalize();
		});

		const form = new FormData();
		form.append("file", fs.createReadStream(`${filePath}.zip`));

		const options = {
			headers: {
				Authorization: `Bearer ${unexpectedToken}`,
				...form.getHeaders(),
			},
		};

		const responseDeploy = await axios.post(
			`https://hobbit-db-be.fly.dev/pages/${projectId}/deployments`,
			form,
			options,
		);

		const deployData = responseDeploy.data as { message: string };

		if (deployData && deployData.message !== "ok") {
			throw new Error("Something went wrong, deployment unsuccessful");
		}

		const response = await axios.get(`https://hobbit-db-be.fly.dev/pages/cf/deployments/${projectName}`, {
			headers: { Authorization: `Bearer ${unexpectedToken}` },
		});

		if (response.status !== 200) {
			throw new Error("Failed to fetch deployment data");
		}

		fs.unlinkSync(`${filePath}.zip`);

		const deploymentData = response.data as Deployment;
		return deploymentData;
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
		const { project, projectId } = await getProject();

		const productionEnvironment = githubBranch === project.production_branch || branch === project.production_branch;
		const environmentName = `${projectName} (${productionEnvironment ? "Production" : "Preview"})`;

		let gitHubDeployment: Awaited<ReturnType<typeof createGitHubDeployment>>;

		if (gitHubToken && gitHubToken.length) {
			const octokit = getOctokit(gitHubToken);
			gitHubDeployment = await createGitHubDeployment(octokit, productionEnvironment, environmentName);
		}

		const pagesDeployment = await createPagesDeployment(projectId);
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
