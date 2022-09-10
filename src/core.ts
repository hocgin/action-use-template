import * as github from '@actions/github';
import {
    RepositoryCreatedEvent
} from '@octokit/webhooks-definitions/schema'
import * as fs from "fs";
import * as path from "path";
import {glob} from "glob";
import {Inputs} from "./main";


export async function run(input: Inputs) {
    const octokit = github.getOctokit(process.env.GITHUB_TOKEN!);
    let context = github.context;
    let repository_name = context.payload.repository?.name;
    let repository_full_name = context.payload.repository?.full_name;
    let repository_html_url = context.payload.repository?.html_url;
    let git_ref = context.ref;

    let envFile = input.env_file;
    let leftDelim = input.left_delim;
    let rightDelim = input.right_delim;
    let env = input.env;
    let overflowReadmeFile = input.overflow_readme_file;
    let excludes = (input.excludes ?? '').split(',').map((value) => value.trim());
    let sender;

    if (context.eventName === 'created') {
        const payload = context.payload as RepositoryCreatedEvent;
        sender = payload.sender;
        payload.repository.master_branch;
    }

    const baseDir = path.resolve(process.cwd());
    let files = glob.sync(`${baseDir}/${input.path}`, {
        nodir: true,
        ignore: excludes.map((value) => path.join(baseDir, value))
    });

    if (overflowReadmeFile && fs.existsSync(overflowReadmeFile)) {
        let data = fs.readFileSync(overflowReadmeFile);
        fs.writeFileSync(data, path.resolve(baseDir, 'README.md'), {flag: 'w'});
    }

    let envObject = {
        repository_name,
        repository_full_name,
        repository_html_url,
        git_ref
    };
    if (envFile) {
        let file = path.resolve(baseDir, envFile);
        if (!fs.existsSync(file)) {
            throw new Error('input [`env_file`] not found');
        }
        let envFileJson = JSON.parse(fs.readFileSync(file) as any) ?? {};
        envObject = {
            ...envObject,
            ...envFileJson
        }
    }
    if (env && env.indexOf('=') > 0) {
        let envJson: any = {};
        env.split(',').map((value) => value?.split('=', 2) ?? [])
            .filter(value => value.length === 2).forEach(value => envJson[value[0]] = value[1]);
        envObject = {
            ...envObject,
            ...envJson
        }
    }

    let changeFiles = [];
    for (let file of files) {
        let isChanged = templateFile(file, file, leftDelim, rightDelim, envObject);
        if (isChanged) {
            changeFiles.push(file.substring(`${baseDir}/`.length));
        }
    }

    let owner = context.repo.owner;
    let repo = context.repo.repo;

    const currentCommit = await octokit.git.getCommit({
        owner,
        repo,
        commit_sha: context.sha,
    });

    const createTree = await octokit.git.createTree({
        owner,
        repo,
        base_tree: currentCommit.data.tree.sha,
        tree: changeFiles.map(path => ({
            path,
            mode: '100644',
            content: String(fs.readFileSync(path))
        }))
    })

    let newTreeSha = createTree.data.sha;

    let newCommit = await octokit.git.createCommit({
        owner,
        repo,
        message: 'update template variables',
        tree: newTreeSha,
        parents: [currentCommit.data.sha],
    });

    await octokit.git.updateRef({
        owner,
        repo,
        ref: context.ref.substring('refs/'.length),
        sha: newCommit.data.sha,
        force: true
    });
}

let templateFile = (inputFile: string, outputFile: string, leftDelim: string, rightDelim: string, jsonObject: any = {}): boolean => {
    console.log(`template file: ${inputFile}, output file: ${outputFile}`);
    if (!fs.existsSync(inputFile)) {
        return false;
    }
    leftDelim = escape(leftDelim);
    rightDelim = escape(rightDelim);

    let keys = Object.keys(jsonObject) ?? [];
    let data = fs.readFileSync(inputFile);

    if (!data) {
        return false;
    }
    let txt: string = String(data);

    for (let key of keys) {
        if (!key) return false;
        let value = jsonObject[key];
        let keyRegex = new RegExp(`${leftDelim}\s${key}\s${rightDelim}`, 'g');
        txt = txt.replace(keyRegex, value);
    }
    fs.writeFileSync(outputFile, txt, {flag: 'w'})
    return true;
}

let escape = (text: string): string => {
    return text.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, "\\$&");
}
