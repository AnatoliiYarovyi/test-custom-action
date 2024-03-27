import { Project } from "@cloudflare/types";

const accountId = "597b122d6184c8fdf34c63645d72d44d";
const projectName = "test-react-cloudflare";
const apiToken = "_kSCvQMDpNFogXLa_aEjgXdCDVySFyiUiX_OjZrs";

const getProject = async () => {
	const response = await fetch(
		`https://api.cloudflare.com/client/v4/accounts/${accountId}/pages/projects/${projectName}`,
		{
			headers: { Authorization: `Bearer ${apiToken}` },
		},
	);

	const { result } = (await response.json()) as { result: Project | null };
	console.log("response: ", result);
};

const getProjectProxy = async () => {
	const proxy = await fetch(
		`https://proxy-cloudflare-production.up.railway.app/proxy/getProject/${accountId}/${projectName}`,
		{
			headers: { token: apiToken },
		},
	);

	const { result } = (await proxy.json()) as { result: Project | null };
	console.log("proxy: ", result);
};

getProject();
getProjectProxy();
