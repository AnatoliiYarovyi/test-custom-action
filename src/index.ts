import { getInput, setOutput, setFailed, summary } from "@actions/core";
import type { Project, Deployment } from "@cloudflare/types";
import { context, getOctokit } from "@actions/github";
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

const domains: string[] = [];

try {
	const projectName = getInput("projectName", { required: true });
	const databaseId = getInput("databaseId", { required: true });
	const directory = getInput("directory", { required: true });
	const unexpectedToken = getInput("unexpectedToken", { required: true });
	const gitHubToken = getInput("gitHubToken", { required: false });
	const branch = getInput("branch", { required: false });
	const workingDirectory = getInput("workingDirectory", { required: false });

	const getProjectId = async (): Promise<string> => {
		try {
			const responsePages = await axios.get(`https://api.unexpected.app/pages/dfd/dfd?databaseId=${databaseId}`, {
				headers: { Authorization: `Bearer ${unexpectedToken}` },
			});
			const responsePagesData = responsePages.data as IResponsePagesData;

			const responseProjectData = responsePagesData.items.find((el) => el.name === projectName);

			if (!responseProjectData || !responseProjectData.id) {
				const response = await axios.post(
					`https://api.unexpected.app/pages`,
					{
						projectName,
						databaseId,
					},
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
		} catch (error: any) {
			console.error("Error occurred:", error?.message || error);
			throw new Error("Failed to get project ID");
		}
	};

	const getProject = async () => {
		try {
			const projectId = await getProjectId();

			const response = await axios.get(`https://api.unexpected.app/pages/cf/projects/${projectName}`, {
				headers: { Authorization: `Bearer ${unexpectedToken}` },
			});

			if (response.status !== 200) {
				throw new Error("Failed to fetch project data");
			}

			const projectData = response.data as Project;
			domains.push(...projectData.domains);

			return { project: projectData, projectId };
		} catch (error: any) {
			console.error("Error occurred:", error?.message || error);
			throw new Error("Failed to get project data");
		}
	};

	const deploymentApp = async (projectId: string) => {
		try {
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
				`https://api.unexpected.app/pages/${projectId}/deployments`,
				form,
				options,
			);
			fs.unlinkSync(`${filePath}.zip`);

			const deployData = responseDeploy.data as { message: string };

			if (deployData && deployData.message !== "ok") {
				throw new Error("Something went wrong, deployment unsuccessful");
			}
		} catch (error: any) {
			console.error("Error occurred:", error?.message || error);
			throw new Error("Failed to deploy app");
		}
	};

	const createPagesDeployment = async () => {
		try {
			const response = await axios.get(`https://api.unexpected.app/pages/cf/deployments/${projectName}`, {
				headers: { Authorization: `Bearer ${unexpectedToken}` },
			});

			if (response.status !== 200) {
				throw new Error("Failed to fetch deployment data");
			}

			const deploymentData = response.data as Deployment;
			return deploymentData;
		} catch (error: any) {
			console.error("Error occurred:", error?.message || error);
			throw new Error("Failed to get deployment data");
		}
	};

	const githubBranch = env.GITHUB_HEAD_REF || env.GITHUB_REF_NAME;

	const createGitHubDeployment = async (octokit: Octokit, productionEnvironment: boolean, environment: string) => {
		const deployment = await octokit.rest.repos.createDeployment({
			owner: context.repo.owner,
			repo: context.repo.repo,
			ref: githubBranch || context.ref,
			auto_merge: false,
			description: "Hobbit Pages",
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
			// log_url: ``,
			description: "Hobbit Pages",
			state: "success",
			auto_inactive: false,
		});
	};

	const createJobSummary = async ({ deployment }: { deployment: Deployment }) => {
		const deployStage = deployment.stages.find((stage) => stage.name === "deploy");

		let status = "⚡️  Deployment in progress...";

		if (deployStage?.status === "success") {
			status = "✅  Deploy successful!";
		} else if (deployStage?.status === "failure") {
			status = "🚫  Deployment failed";
		}

		const urls = domains.reduce((acc, el) => {
			acc += `https://${el}<br>`;

			return acc;
		}, ``);

		await summary
			.addRaw(
				`
# Deploying with Hobbit Pages

| Name              | Result |
| ----------------- | - |
| **Status**:       | ${status} |
| **URL**:          | ${urls} |
| **Preview URL**:  | ${deployment.url} |
| **Notification**: | If this is your first deployment, the page will start working in 5-10 minutes.<br>There will be no such delays in the future. |
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
		await deploymentApp(projectId);
		let pagesDeployment = await createPagesDeployment();
		if (!pagesDeployment?.stages) {
			console.log("==================================");
			console.log("Deploy status: ", pagesDeployment.stages);
			console.log("Retrying to get “Deploy status”, please wait 20 seconds.");
			console.log("This sometimes happens when you first deploy a new project");
			console.log("==================================");

			await new Promise((resolve) => setTimeout(resolve, 20000));
			pagesDeployment = await createPagesDeployment();
		}
		setOutput("id", pagesDeployment.id);
		setOutput("url", pagesDeployment.url);
		setOutput("environment", pagesDeployment.environment);

		await createJobSummary({ deployment: pagesDeployment });

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
